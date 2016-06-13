"use strict";
/*jslint node: true, nomen: true, vars: true */
var fs = require('fs-extra');
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

describe('CanvasCat', function () {
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
    // Define tests that get path multiple times, ensure mime type, and any optionalTests({response, body}),
    function page(path, optionalTests) {
        var data = {};
        it('get ' + path, function (done) {
            request(base + path, function (error, res, bod) {
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
        var method = 'POST';
        auth(pathname, method);
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
            assert.equal(data.$('name').text(), 'Memetic Hazard 2');
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
    function updatePaths(user) {
        var uname = encodeURIComponent(user.username.toLowerCase()).replace(/%../g, '+');
        user.path = '/member/' + uname + '/profile.html';
        user.update = user.path.replace('member', 'update-member');
        user.newArt = '/update-art/' + uname + '/new.html';
    }
    var user1 = {title: 'testuser 1', username: 'testuser1', email: 'test1@canvascat.com', password: 'foo', repeatPassword: 'foo'};
    var user2 = {title: 'testuser 2', username: 'test user 2', email: 'test2@canvascat.com', password: 'bar', repeatPassword: 'bar',
                 website: 'http://canvascat.com', description: 'This is a test user.'};
    var newMember = '/update-member/new/profile.html';
    updatePaths(user1);
    updatePaths(user2);

    describe('member', function () {
        function confirmMember(member) {
            it('has correct title', function () {
                assert.equal(member.$('name').text(), member.title);
            });
            it('has correct website', function () {
                assert.equal(member.$('website').text(), member.website || '');
            });
            it('has correct description', function () {
                assert.equal(member.$('description').text(), member.description || '');
            });
            it('has image', function (done) {
                if (!member.picture) {
                    assert.ok(member.$('img').is('img'));
                    done();
                } else {
                    request(base + member.$('img').attr('src'), function (e, res, body) {
                        assert.ifError(e);
                        var mime = res.headers['content-type'];
                        assert.equal(mime.slice(0, mime.indexOf('/')), 'image');
                        assert.equal(body, member.picture.value);
                        done();
                    });
                }
            });
            it('has update', function () {
                assert.equal(member.$('update a').attr('href'), member.update);
            });
            it('has add-art', function () {
                assert.equal(member.$('add-art a').attr('href'), member.newArt);
            });
            it('has add-member', function () {
                assert.equal(member.$('add-member a').attr('href'), newMember);
            });
        }

        describe('creation', function () {
            function requires(property, submittedData, optionalMessage, optionalCode) {
                it('requires ' + property, function (done) {
                    request({uri: base + newMember, method: 'POST', formData: submittedData}, function (e, res, body) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, optionalCode || 400, res.statusMessage);
                        var $ = cheerio.load(body);
                        assert.equal($('error').text(), optionalMessage || ('Missing required data: ' + property));
                        done();
                    });
                });
            }
            describe('upload form', function () {
                page(newMember, function (data) {
                    it('form has name', function () {
                        data.$ = cheerio.load(data.body);
                        assert.equal(data.$('form name input').attr('name'), 'title');
                    });
                    it('has website', function () {
                        assert.equal(data.$('form website input').attr('name'), 'website');
                    });
                    it('has description', function () {
                        assert.equal(data.$('form description input').attr('name'), 'description');
                    });
                    it('has email', function () {
                        assert.equal(data.$('form email input').attr('name'), 'email');
                    });
                    it('has password', function () {
                        assert.equal(data.$('form password input').attr('name'), 'password');
                    });
                    it('has picture', function () {
                        assert.equal(data.$('form picture input').attr('name'), 'picture');
                    });
                });
            });

            describe('server checks', function () {
                requires('title', {});
                requires('username', {title: 't'});
                requires('email', {title: 't', username: 'u'});
                requires('passwordHash', {title: 't', username: 'u', email: 'e'});
                requires('matching password', {title: 't', username: 'u', email: 'e', password: 'foo'}, 'Passwords do not match.');
            });

            describe('initial member upload', function () {
                it('allows missing website, description, and picture', function (done) {
                    request({uri: base + newMember, method: 'POST', formData: user1, followAllRedirects: true}, function (e, res, body) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, 200, res.statusMessage);
                        user1.$ = cheerio.load(body);
                        done();
                    });
                });
                confirmMember(user1);
                page(user1.path, function (data) {
                    it('parses as html', function (done) {
                        user1.$ = cheerio.load(data.body);
                        done();
                    });
                    confirmMember(user1);
                });
            });
            describe('second initial member upload', function () {
                var badUser = JSON.parse(JSON.stringify(user2));
                badUser.username = user1.username;
                before(function (done) {
                    var filename = 'test2.jpg', ext = path.extname(filename).slice(1), mime = 'image/' + ext;
                    fs.readFile(path.join(__dirname, 'test2.jpg'), function (e, buf) {
                        user2.picture = {value: buf, options: {filename: filename, contentType: mime}};
                        done(e);
                    });
                });
                requires('unique username', badUser, 'Username ' + user1.username + ' is already in use.', 409);
                it('allows specified website, description, and picture', function (done) {
                    request({uri: base + newMember, method: 'POST', formData: user2, followAllRedirects: true}, function (e, res, body) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, 200, res.statusMessage);
                        user2.$ = cheerio.load(body);
                        done();
                    });
                });
                confirmMember(user2);
                page(user2.path, function (data) {
                    it('parses as html', function (done) {
                        user2.$ = cheerio.load(data.body);
                        done();
                    });
                    confirmMember(user2);
                });
            });
        });
        
        describe('update', function () {
        });
    });

    describe('cleanup', function () {
        function deletes(path) { // FIXME: require authorization!
            var uri = base + path;
            it('deletes ' + path, function (done) {
                request({uri: uri, method: 'DELETE'}, function (e, res, b) {
                    assert.ifError(e);
                    assert.equal(res.statusCode, 200, res.statusMessage);
                    assert.ok(b);
                    // And now a GET produces file-not-found.
                    request(uri, function (e, res) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, 404, res.statusMessage);
                        done();
                    });
                });
            });
        }
        deletes(user1.path);
        deletes(user2.path);
    });
});
