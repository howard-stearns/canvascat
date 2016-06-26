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

// Testing always involves a bit of a trade-off between how much is defined parametrically for different cases,
// vs being nearly repeated in the different cases. Our trade-off here is... evolving.

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

    // Define tests that get path multiple times, ensure mime type, and any optionalTests({response, body}),
    function page(path, optionalTests, optionalAuth) {
        var data = {};
        var options = {uri: base + path};
        if (optionalAuth) { options.auth = optionalAuth; }
        it('get ' + path, function (done) {
            request(options, function (error, res, bod) {
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
            this.timeout(10 * 1000);
            async.times(n, function (n, ncb) {
                _.noop(n);
                request(options, ncb);
            }, function (e) {
                assert.ifError(e);
                var elapsed = Date.now() - start;
                stats[path] = (n * 1000) / elapsed;
                done();
            });
        });
    }
    function cleanNametag(nametag) { return encodeURIComponent(nametag.toLowerCase()).replace(/%../g, '+'); }
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
    function updateMemberPaths(user) {
        var uname = cleanNametag(user.username);
        user.path = '/member/' + uname + '/profile.html';
        user.update = user.path.replace('member', 'update-member');
        user.newArt = '/update-art/' + uname + '/new.html';
    }
    function updateCompositionPaths(art, member) {
        var name = cleanNametag(art.name);
        art.path = member.path.replace('profile', name).replace('member', 'art');
        art.update = art.path.replace('art', 'update-art');
        art.newArt = art.update.replace(name, 'new');
    }
    var user1 = {name: 'testuser 1', username: 'testuser1', email: 'test1@canvascat.com', password: 'foo', repeatPassword: 'foo'};
    var user2 = {name: 'testuser 2', username: 'test user 2', email: 'test2@canvascat.com', password: 'bar', repeatPassword: 'bar',
                 website: 'http://canvascat.com', description: 'This is a test user.'};
    var auth1 = {user: cleanNametag(user1.username), pass: user1.password};
    var auth2 = {user: cleanNametag(user2.username), pass: user2.password};
    var badUser1 = JSON.parse(JSON.stringify(user1)), badUser2 = JSON.parse(JSON.stringify(user2));
    badUser1.username = user2.username.replace(/ /g, '+'); // which "cleans" to the same thing;
    badUser2.username = user1.username;
    var newMember = '/update-member/new/profile.html';
    var art1 = {name: 'test art 1', price: '100', dimensions: '10x20x1', medium: 'oil'};
    var art2 = {name: 'test art 2', price: '1000', dimensions: '100x50x5', medium: 'mixed',
                description: 'This is test art 1.', category: 'nude landscape'};
    updateMemberPaths(user1);
    updateMemberPaths(user2);
    updateCompositionPaths(art1, user1);
    updateCompositionPaths(art2, user1);
    function uploadRequires(path, property, submittedData, optionalMessage, optionalCode, auth) {
        it('requires ' + property, function (done) {
            delete submittedData.$; // in case there's any cruft left
            var data = {uri: base + path, method: 'POST', formData: submittedData};
            if (auth) { data.auth = auth; }
            request(data, function (e, res, body) {
                assert.ifError(e);
                assert.equal(res.statusCode, optionalCode || 400, res.statusMessage);
                if (optionalMessage !== false) {
                    var $ = cheerio.load(body);
                    assert.equal($('error').text(), optionalMessage || ('Missing required data: ' + property));
                }
                done();
            });
        });
    }
    function confirmGenericUpload(confirmFunction, suiteName, route, object, imageFilename, auth, newData, updater) {
        describe(suiteName, function () {
            before(function (done) {
                var filename = imageFilename, ext = path.extname(filename).slice(1), mime = 'image/' + ext;
                if (newData) { _.extend(object, newData); }
                if (updater) { updater(object); }
                fs.readFile(path.join(__dirname, imageFilename), function (e, buf) {
                    object.picture = {value: buf, options: {filename: filename, contentType: mime}};
                    done(e);
                });
            });
            it('allows specified website, description, and picture', function (done) {
                var options = {uri: route, method: 'POST', formData: object, followAllRedirects: true};
                delete object.$; // if any. we don't want to upload that
                if (auth) { options.auth = auth; }
                request(options, function (e, res, body) {
                    assert.ifError(e);
                    assert.equal(res.statusCode, 200, res.statusMessage);
                    object.$ = cheerio.load(body);
                    done();
                });
            });
            confirmFunction(object); // confirming result of upload
            page(object.path, function (data) {
                it('parses as html', function (done) {
                    object.$ = cheerio.load(data.body);
                    done();
                });
                confirmFunction(object); // confirming result of get
            });
        });
    }

    describe('member', function () {
        function confirmMember(member) {
            it('has correct name', function () {
                assert.equal(member.$('name').text(), member.name);
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
                    member.picture.url = member.$('img').attr('src'); // so that we can clean up later
                    request(base + member.picture.url, function (e, res, body) {
                        assert.ifError(e);
                        var mime = res.headers['content-type'];
                        assert.equal(mime.slice(0, mime.indexOf('/')), 'image');
                        assert.equal(body, member.picture.value);
                        done();
                    });
                }
            });
            it('has correct update', function () {
                assert.equal(member.$('update a').attr('href'), member.update);
            });
            it('has correct add-art', function () {
                assert.equal(member.$('add-art a').attr('href'), member.newArt);
            });
            it('has correct add-member', function () {
                assert.equal(member.$('add-member a').attr('href'), newMember);
            });
        }
        function confirmUpload(suiteName, route, user, imageFilename, auth, newData, updater) {
            confirmGenericUpload(confirmMember, suiteName, route, user, imageFilename, auth, newData, updater);
        }
        describe('creation', function () {
            describe('upload form', function () {
                var $;
                function check(selector, propertyName) {
                    var element = $(selector);
                    assert.equal(element.attr('name'), propertyName);
                }
                page(newMember, function (data) {
                    it('form has name', function () {
                        $ = cheerio.load(data.body);
                        check('form name input', 'name');
                    });
                    it('has website', function () {
                        check('form website input', 'website');
                    });
                    it('has description', function () {
                        check('form description input', 'description');
                    });
                    it('has email', function () {
                        check('form email input', 'email');
                    });
                    it('has password', function () {
                        check('form password input', 'password');
                    });
                    it('has picture', function () {
                        check('form picture input', 'picture');
                    });
                });
            });
            function requires(property, submittedData, optionalMessage, optionalCode) {
                uploadRequires(newMember, property, submittedData, optionalMessage, optionalCode);
            }
            describe('server checks', function () {
                requires('name', {});
                requires('username', {name: 't'});
                requires('email', {name: 't', username: 'u'});
                requires('passwordHash', {name: 't', username: 'u', email: 'e'});
                requires('matching password', {name: 't', username: 'u', email: 'e', password: 'foo'}, 'Passwords do not match.');
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
                describe('result', function () {
                    page(user1.path, function (data) {
                        it('parses as html', function (done) {
                            user1.$ = cheerio.load(data.body);
                            done();
                        });
                        confirmMember(user1);
                    });
                });
                requires('unique username', badUser2, 'Username ' + user1.username + ' is already in use.', 409);
            });
            confirmUpload('second initial member upload', base + newMember, user2, 'test2.jpg');
        });

        describe('update', function () {
            describe('form', function () {
                it('requires authentication', function (done) {
                    request(base + user1.update, function (e, res) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, 401, res.statusMessage);
                        done();
                    });
                });
                it('requires authorization for same user', function (done) {
                    request({uri: base + user1.update, auth: auth2}, function (e, res) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, 403, res.statusMessage);
                        done();
                    });
                });
                page(user1.update, function (data) {
                    var $;
                    function check(selector, propertyName, enforceNoValue) {
                        var element = $(selector);
                        assert.equal(element.attr('name'), propertyName);
                        assert.equal(element.attr('value'), enforceNoValue ? undefined : user1[propertyName]);
                    }
                    it('has name', function () {
                        $ = cheerio.load(data.body);
                        check('form name input', 'name');
                    });
                    it('has website', function () {
                        check('form website input', 'website');
                    });
                    it('has description', function () {
                        check('form description input', 'description');
                    });
                    it('has email', function () {
                        check('form email input', 'email');
                    });
                    it('has password', function () {
                        check('form password input', 'password', true);
                    });
                    it('has picture', function () {
                        check('form picture input', 'picture');
                    });
                }, auth1);
            });
            function requires(property, submittedData, optionalMessage, optionalCode, auth) {
                uploadRequires(user1.update, property, submittedData, optionalMessage, optionalCode, auth);
            }
            describe('server checks', function () {
                requires('authentication', {}, false, 401);
                requires('authorized user', {}, false, 403, auth2);
                requires('name', {name: ''}, undefined, undefined, auth1);
                requires('username', {name: 't', username: ''}, undefined, undefined, auth1);
                requires('email', {name: 't', username: 'u', email: ''}, undefined, undefined, auth1);
                requires('matching password', {name: 't', username: 'u', email: 'e', repeatPassword: 'foo'}, 'Passwords do not match.', undefined, auth1);
                requires('unique username', badUser1, 'Username ' + cleanNametag(user2.username) + ' is already in use.', 409, auth1);
            });
            confirmUpload('member update', base + user1.update, user1, 'test1.jpg', auth1, {username: 'test user 1'}, updateMemberPaths);
        });
    });

    describe('composition', function () {
        function confirmComposition(composition) {
            it('has correct name', function () {
                assert.equal(composition.$('name').text(), composition.name);
            });
            it('has correct description', function () {
                assert.equal(composition.$('description').text(), composition.description || '');
            });
            it('has image', function (done) {
                if (!composition.picture) {
                    assert.ok(composition.$('img').is('img'));
                    done();
                } else {
                    composition.picture.url = composition.$('img').attr('src'); // so that we can clean up later
                    request(base + composition.picture.url, function (e, res, body) {
                        assert.ifError(e);
                        var mime = res.headers['content-type'];
                        assert.equal(mime.slice(0, mime.indexOf('/')), 'image');
                        assert.equal(body, composition.picture.value);
                        done();
                    });
                }
            });
            it('has correct update', function () {
                assert.equal(composition.$('update a').attr('href'), composition.update);
            });
            it('has correct add-art', function () {
                assert.equal(composition.$('add-art a').attr('href'), composition.newArt);
            });
            it('has correct add-composition', function () {
                assert.equal(composition.$('add-member a').attr('href'), newMember);
            });
        }
        function confirmUpload(suiteName, route, user, imageFilename, auth, newData, uploader) {
            confirmGenericUpload(confirmComposition, suiteName, route, user, imageFilename, auth, newData, uploader);
        }
        describe('creation', function () {
            describe('upload form', function () {
                var $;
                function check(selector, propertyName) {
                    var element = $(selector);
                    assert.equal(element.attr('name'), propertyName);
                }
                it('requires authentication', function (done) {
                    updateCompositionPaths(art1, user1); // Becuase the member tests can change the data from the static values
                    updateCompositionPaths(art2, user1);
                    request(base + user1.newArt, function (e, res) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, 401, res.statusMessage);
                        done();
                    });
                });
                it('requires authorization for same user', function (done) {
                    request({uri: base + user1.newArt, auth: auth2}, function (e, res) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, 403, res.statusMessage);
                        done();
                    });
                });
                page(user1.newArt, function (data) {
                    it('form has name', function () {
                        $ = cheerio.load(data.body);
                        check('form name input', 'name');
                    });
                    it('has description', function () {
                        check('form description input', 'description');
                    });
                    it('has price', function () {
                        check('form price input', 'price');
                    });
                    it('has dimensions', function () {
                        check('form dimensions input', 'dimensions');
                    });
                    it('has medium', function () {
                        check('form medium input', 'medium');
                    });
                    it('has category', function () {
                        check('form category input', 'category');
                    });
                    it('has picture', function () {
                        check('form picture input', 'picture');
                    });
                }, auth1);
            });
            function requires(property, submittedData, optionalMessage, optionalCode, optionalAuth) {
                uploadRequires(user1.newArt, property, submittedData, optionalMessage, optionalCode, (optionalAuth === null) ? undefined : (optionalAuth ||  auth1));
            }
            describe('server checks', function () {
                requires('authentication', {}, false, 401, null);
                requires('authorized user', {}, false, 403, auth2);
                requires('name', {});
                requires('price', {name: 't'});
                requires('dimensions', {name: 't', price: '100'});
                requires('medium', {name: 't', price: '100', dimensions: '1x2x3'});
            });

            describe('initial composition upload', function () {
                it('allows missing description, and category', function (done) {
                    request({uri: base + user1.newArt, method: 'POST', formData: art1, followAllRedirects: true, auth: auth1}, function (e, res, body) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, 200, res.statusMessage);
                        art1.$ = cheerio.load(body);
                        done();
                    });
                });
                confirmComposition(art1);
                describe('result', function () {
                    page(art1.path, function (data) {
                        it('parses as html', function (done) {
                            art1.$ = cheerio.load(data.body);
                            done();
                        });
                        confirmComposition(art1);
                    });
                });
                requires('unique name', art1, 'Composition nametag ' + cleanNametag(art1.name) + ' is already in use.', 409, auth1);
            });
            confirmUpload('second initial composition upload', base + user1.newArt, art2, 'test2.jpg', auth1);
        });

        describe('update', function () {
            describe('form', function () {
                it('requires authentication', function (done) {
                    request(base + art1.update, function (e, res) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, 401, res.statusMessage);
                        done();
                    });
                });
                it('requires authorization for same user', function (done) {
                    request({uri: base + art1.update, auth: auth2}, function (e, res) {
                        assert.ifError(e);
                        assert.equal(res.statusCode, 403, res.statusMessage);
                        done();
                    });
                });
                page(art1.update, function (data) {
                    var $;
                    function check(selector, propertyName, enforceNoValue) {
                        var element = $(selector);
                        assert.equal(element.attr('name'), propertyName);
                        assert.equal(element.attr('value'), enforceNoValue ? undefined : art1[propertyName]);
                    }
                    it('has name', function () {
                        $ = cheerio.load(data.body);
                        check('form name input', 'name');
                    });
                    it('has description', function () {
                        check('form description input', 'description');
                    });
                    it('has price', function () {
                        check('form price input', 'price');
                    });
                    it('has dimensions', function () {
                        check('form dimensions input', 'dimensions');
                    });
                    it('has medium', function () {
                        check('form medium input', 'medium');
                    });
                    it.skip('has category', function () {
                        check('form category input', 'category');
                    });
                    it('has picture', function () {
                        check('form picture input', 'picture');
                    });
                }, auth1);
            });
            function requires(property, submittedData, optionalMessage, optionalCode, auth) {
                uploadRequires(art1.update, property, submittedData, optionalMessage, optionalCode, auth);
            }
            describe('server checks', function () {
                requires('authentication', {}, false, 401, null);
                requires('authorized user', {}, false, 403, auth2);
                requires('name', {name: ''}, undefined, undefined, auth1);
                requires('price', {name: 't', price: ''}, undefined, undefined, auth1);
                requires('dimensions', {name: 't', price: '100', dimensions: ''}, undefined, undefined, auth1);
                requires('medium', {name: 't', price: '100', dimensions: '1x2x3', medium: ''}, undefined, undefined, auth1);
                requires('unique name', art2, 'Composition nametag ' + cleanNametag(art2.name) + ' is already in use.', 409, auth1);
            });
            confirmUpload('composition update', base + art1.update, art1, 'test1.jpg', auth1,
                          {name: 'art 1', price: '200'}, function (data) { updateCompositionPaths(data, user1); });
        });
    });

    describe('cleanup', function () {
        function deletes(label, optionalPathGenerator) {
            function uriGenerator() {
                if (optionalPathGenerator) {
                    return base + optionalPathGenerator();
                }
                return base + label;
            }
            it('requires localhost for delete ' + label, function (done) {
                var uri = uriGenerator();
                request({uri: uri.replace('localhost', '127.0.0.1'), method: 'DELETE'}, function (e, res) {
                    assert.ifError(e);
                    assert.equal(res.statusCode, 403, res.statusMessage);
                    done();
                });
            });
            it('deletes ' + label, function (done) {
                var uri = uriGenerator();
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
        deletes(art1.path);
        deletes(art2.path);
        deletes(user1.path);
        deletes(user2.path);
        deletes('picture1', function () { return user1.picture.url; });
        deletes('picture2', function () { return user2.picture.url; });
    });
});
