"use strict";
/*jslint node: true, nomen: true, vars: true */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var assert = require('assert');
var mocha = require('mocha'), describe = mocha.describe, before = mocha.before, after = mocha.after, it = mocha.it;
var shell = require('child_process');
var async = require('async');
var request = require('request');
var cheerio = require('cheerio');
var _ = require('underscore');
var testUserPass = process.env.TEST_USER_AUTH;
if (!testUserPass) { throw new Error('Please specify TEST_USER_AUTH'); }
var credentials = {user: 'howard', pass: testUserPass};

describe('server', function () {
    var port = 3000, base = 'http://localhost:' + port, ourServer; // the server we should talk to
    var stats = {};
    function serverIsRunning() { // true if the server is listening
        // Use /index.html because that is the default AWS load-balancer health test
        return shell.spawnSync('curl', ['http://localhost:' + port + '/index.html']).status === 0;
    }
    function waitForChange(wantsRunning, cb) { // cb() only when serverIsRunning matches wantsRunning
        var loop = wantsRunning ? async.doUntil : async.doWhilst;
        loop(function (icb) {
            setTimeout(icb, 1000);
        }, serverIsRunning, cb);
    }

    // assertions
    function assertOk(res) { assert.deepEqual(res, {status: 'ok'}); } // Normal uninformative-but-ok json response
    // reuseable tests
    function auth(path, method) { // method (e.g., 'get') path requires auth
        // For delete method and the admin routes, we will require an admin user.
        method = method || 'get';
        var title = 'checks authorization for ' + path + ' ' + method;
        if (method === 'skip') { return it.skip(title); }
        it(title, function (done) {
            request({url: base + path, method: method, auth: {user: 'BAD'}}, function (error, res) {
                assert.ifError(error);
                assert.equal(res.statusCode, 401, res.statusMessage);
                done();
            });
        });
    }
    function maybeAuthed(path) { // media requires credentials, other get methods do not.
        var opts = {url: base + path};
        if (path.indexOf('media') !== -1) { opts.auth = credentials; }
        return opts;
    }
    // Define tests that get path multiple times, ensure mime type, and any optionalTests({response, body}),
    function page(path, optionalTests) {
        var data = {};
        it('get ' + path, function (done) {
            request(maybeAuthed(path), function (error, res, bod) {
                assert.ifError(error);
                data.response = res;
                data.body = bod;
                assert.equal(data.response.statusCode, 200, data.response.statusMessage);
                done();
            });
        });
        if (optionalTests) { optionalTests(data); }
        it('multiple get ' + path, function (done) {
            // This isn't a load test. It's a smoke test that path can be called a lot on the same machine without something going seriously wrong.
            var start = Date.now();
            var n = 100;
            var uri = base + path;
            this.timeout(10 * 1000);
            async.times(n, function (n, ncb) {
                _.noop(n);
                request(uri, ncb);
            }, function (e) {
                assert.ifError(e);
                var elapsed = Date.now() - start;
                stats[path] = (n * 1000) / elapsed;
                done();
            });
        });
    }
    function upload(pathname, data, optionalExpected) {
        // if data.filename, we read that instead, and set data.buffer to the content, and data.mime
        var expectedResponse = optionalExpected || {status: 'ok'};
        var dir = path.dirname(pathname);
        // Two of these don't correspond to get's with the same name, and so use 'POST'. The rest are 'PUT' semantics.
        var method = _.contains(['/fbusr', '/pRefs'], dir) ? 'POST' : 'PUT';
        auth(pathname, ('/fbusr' === dir) ? 'skip' :  method); // FIXME: Don't skip auth for /fbusr
        it('uploads ' + pathname, function (done) {
            var body = {uri: base + pathname, method: method, auth: credentials};
            function testBody() {
                request(body, function (e, res, body) {
                    assert.ifError(e);
                    assert.equal(res.statusCode, 200, res.statusMessage);
                    if (_.isString(body)) { body = JSON.parse(body); } // ... but request() doesn't parse it if we post formData.
                    assert.deepEqual(body, expectedResponse);
                    done();
                });
            }
            if (data.filename) {
                fs.readFile(path.join(__dirname, data.filename), function (e, buf) {
                    var basename = path.basename(data.filename), ext = path.extname(basename).slice(1);
                    assert.ifError(e);
                    data.buffer = buf;
                    data.mime = 'image/' + ext;
                    body.formData = {fileUpload: {value: buf, options: {filename: basename, contentType: data.mime}}};
                    testBody();
                });
            } else {
                body.json = data;
                testBody();
            }
        });
    }
    // Confirms that path can be DELETEd, after which a GET fails, and authorization is required.
    function deletes(path) {
        var uri = base + path;
        auth(path, 'delete');
        it('deletes ' + path, function (done) {
            request({uri: uri, method: 'DELETE', json: true, auth: credentials}, function (e, res, b) {
                assert.ifError(e);
                assert.equal(res.statusCode, 200, res.statusMessage);
                assertOk(b);
                // And now a GET produces file-not-found.
                request(maybeAuthed(path), function (e, res) {
                    assert.ifError(e);
                    assert.equal(res.statusCode, 404, res.statusMessage);
                    done();
                });
            });
        });
    }
    before(function (done) { // Start server if necessary
        this.timeout(10 * 1000);
        if (serverIsRunning()) { return done(); }
        console.log('Starting server.');
        // If we have to start our own server, we send its log to a file:
        // 1. We want to capture the output in case something goes wrong
        // 2. If we don't, the performance gets very very strange.
        var logStream = fs.createWriteStream('test.server.log');
        // Subtle. It turns out that logStream isn't immediately opened for writing, but spawn requires that it is open.
        // So the solution is to not spawn until the stream is truly open.
        logStream.on('open', function () {
            ourServer = shell.spawn('npm', ['start'], {stdio: ['pipe', logStream, logStream]});
            ourServer.on('exit', function (code) { if (code) { throw new Error("Server failed with code " + code + ". See test.server.log."); } });
            waitForChange(true, done);
        });
    });
    after(function (done) { // Shut down server if we started it
        console.log('Requests per second:'); // See comment for 'multiple get'.
        console.log(stats);
        this.timeout(5 * 1000);
        if (!ourServer) { return done(); }
        console.log('Stopping server.');
        shell.spawn('npm', ['stop']);
        waitForChange(false, done);
    });
    page('/');
    page('/art/howard.stearns/memetic+hazard.html', function (data) {
        it('has title', function () {
            data.$ = cheerio.load(data.body);
            assert.equal(data.$('body title').text(), 'Memetic Hazard 2');
        });
        it('has artist', function () {
            assert.equal(data.$('artist').text(), 'Howard Stearns');
        });
        it('has description', function () {
            assert.equal(data.$('description').text(), 'You tell me match 3');
        });
        it('has medium', function () {
            assert.equal(data.$('medium').text(), 'digital');
        });
        it('has price', function () {
            assert.equal(data.$('price').text(), 'x');
        });
        it('has dimensions', function () {
            assert.equal(data.$('dimensions').text(), '2x4x∞');
        });
        it('has category', function () {
            assert.equal(data.$('category').text(), 'abstract');
        });
        it('has image', function () {
            assert.ok(data.$('img').is('img'));
        });
        it('has update', function () {
            assert.ok(data.$('update a').is('a'));
        });
        it('has add-art', function () {
            assert.ok(data.$('add-art a').is('a'));
        });
        it('has add-member', function () {
            assert.ok(data.$('add-member a').is('a'));
        });
    });
    page('/member/howard/profile.html');
});
