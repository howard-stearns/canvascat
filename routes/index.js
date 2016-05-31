"use strict";
/*jslint node: true, nomen: true, vars: true*/

/* The end purpose of this file is to define "routes" for the URL endpoints specific to this app.
   These are defined at the bottom with router.get, .post, and .use.
   Above them are the functions functions that provide our internal behavior.
 */
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var uuid = require('uuid');
var store = require('ki1r0y.fs-store');
var multer  = require('multer');
var express = require('express');
var router = express.Router();
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var async = require('async');

/////////////////////////////////////////////////////////////////////////////////////////////
/// UTILITIES
/////////////////////////////////////////////////////////////////////////////////////////////
var DEFAULT_PARALLEL_LIMT = 50;
function ignore() { } // Does nothing, and used to document parameters that are deliberately not used.

function secret(key) {   // Grab a secret from the shell environment, or report that it wasn't set.
    if (process.env[key]) { return process.env[key]; }
    throw new Error("Please set environment variable: export " + key + "=theSecretValue");
}
var passwordSecret = secret('PASSWORD_SECRET');
function passwordHash(password, idtag) {
    return crypto.createHmac('sha256', passwordSecret).update(password).update(idtag).digest('hex');
}

// join and resolve are method in the path module, which build up pathnames in the file system.
// join simply concatenates the arguments together with the file system separator in between.
// resolve fixes things up to produce an absolute pathname from root.
var db = path.resolve(__dirname, '..', '..', 'db');  // __dirname is this directory, and is built into node.
var members = path.join(db, 'members');
var memberNametags = path.join(db, 'memberNametags');
var compositions = path.join(db, 'compositions');
var media = path.join(db, 'media');
function memberCollectionname(idtag) {
    return path.join(members, idtag);
}
function memberCompositionsCollectionname(idtag) {
    return path.join(members, idtag, 'compositionNametags');
}
function memberIdtag2Docname(idtag) {
    return path.join(memberCollectionname(idtag), 'profile.json');
}
function compositionNametag2Docname(userIdtag, nametag) {
    return path.join(memberCompositionsCollectionname(userIdtag), nametag);
}
function memberNametag2Docname(nametag) {
    return path.join(memberNametags, nametag);
}
function compositionIdtag2Docname(idtag) {
    return path.join(compositions, idtag + '.json');
}
function mediaUrl(idtag) { // The file extension is already part of the idtag.
    // Even though the results would be the same if we used path.join, here we are returning a
    // (relative) URL, so join is not really expressing what we want. Our URLs always use slashes
    // as separators.
    return '/media/' + idtag;
}
var defaultMemberPictureUrl = mediaUrl('default-member.gif');
// An object that has utilities to parse  multi-part file uploads and place them in uploads directory.
var upload = multer({dest: path.resolve(__dirname, '..', '..', 'uploads')});

// errors
function makeError(message, code) {
    var error = new Error(message);
    if (code) { error.code = code; }
    return error;
}
function forbidden(message) { return makeError(message, 403); }
function unknown(nametag) { return makeError('Unknown ' + nametag, 404); }
function conflict(message) { return makeError(message, 409); }
function tooMany(message) { return makeError(message, 429); }
function badRequest(message) { return makeError(message, 400); }


/////////////////////////////////////////////////////////////////////////////////////////////
/// APP BEHAVIOR
/////////////////////////////////////////////////////////////////////////////////////////////
function ensureMemberCollections(idtag, cb) {
    store.ensureCollection(memberCollectionname(idtag), function (error) {
        if (error) { return cb(error); }
        store.ensureCollection(memberCompositionsCollectionname(idtag), cb);
    });
}

function resolveUsername(username, cb) { // cb(error, memberIdtag)
    store.get(memberNametag2Docname(username), cb);
}
function getMember(username, cb) { // cb(error, memberData, memberIdtag)
    resolveUsername(username, function (error, idtag) {
        if (error) { return cb(error); }
        store.get(memberIdtag2Docname(idtag), function (error, member) {
            if (error) { return cb(error); }
            member.pictureUrl = member.picture ? mediaUrl(member.picture) : defaultMemberPictureUrl;
            member.url  = '/member/' + member.username + '/profile.html';
            member.updateUrl = '/update-member/' + member.username + '/profile.html';
            member.addCompositionUrl = '/update-composition/' + member.username + '/new.html';
            if (!member.firstname && !member.lastname) {
                var split = member.title.split(' ');
                member.firstname = split[0];
                member.lastname = split.slice(1).join(' ');
            }
            cb(null, member, idtag);
        });
    });
}
function getMemberComposition(username, compositionNametag, cb) { // cb(error, compositionData), with artist data resolved
    getMember(username, function (error, member, memberIdtag) {
        if (error) { return cb(error); }
        store.get(compositionNametag2Docname(memberIdtag, compositionNametag), function (error, idtag) {
            if (error) { return cb(error); }
            store.getWithModificationTime(compositionIdtag2Docname(idtag), function (error, composition, modtime) {
                if (error) { return cb(error); }
                composition.pictureUrl = mediaUrl(composition.picture);
                composition.idtag = idtag;
                composition.url = '/art/' + member.username + '/' + composition.nametag + '.html';
                composition.updateUrl = '/update-art/' + member.username + '/' + composition.nametag + '.html';
                composition.addCompositionUrl = member.addCompositionUrl;
                composition.artist = member;
                composition.modified = modtime.getTime();
                cb(null, composition);
            });
        });
    });
}
function normalize(string) {
    // Normalize the data so that searches match.
    // Decompose combined unicode characters into compatible individual marks, so that we can strip them in searches.
    // Remove leading and trailing whitespace.
    // Replace interior whitespace (including tabs) with a single space character.
    return string.normalize('NFKD').trim().replace(/\s+/, ' ');
}
function copyStringProperties(expectedProperties, from, to) { // copy only the listed properties if they have values in 'from'.
    expectedProperties.forEach(function (property) {
        var newValue = from[property];
        if (newValue !== undefined) { // empty string generally allowed
            to[property] = normalize(newValue);
        }
    });
}

// Put the image pointed to by the file object (produced by multer), in the right place and side-effect data
// to reference it, and then cb(error). No-op if file is not supplied.
function handlePictureUpload(file, data, writerFunction) {
    function cb(error) { writerFunction(error, data); }
    function mediaPath(idtag) { return path.join(media, idtag); }
    if (!file) { return setImmediate(cb); }
    var extension = path.extname(file.originalname).toLowerCase();
    if (extension === '.jpg') { extension = '.jpeg'; }
    file.mimetype = file.mimetype.toLowerCase();
    if (file.mimetype !== 'image/' + extension.slice(1)) { // fixme jpg vs jpeg, case
        return writerFunction(badRequest('File extension "' + extension + '" does not match mimetype "' + file.mimetype + '".'));
    }
    fs.readFile(file.path, function (error, buffer) {
        if (error) { return writerFunction(error); }
        var idtag = crypto.createHash('sha256').update(buffer).digest('hex') + extension,
            target = mediaPath(idtag);
        function finish() {
            data.picture = idtag;
            store.rename(file.path, target, cb);
        }
        if (data.picture) {
            var old = mediaPath(data.picture);
            fs.unlink(old, function (error) {
                if (error) { console.log("No data at " + old); }
                finish();
            });
        } else {
            setImmediate(finish);
        }
    });
}

/////////////////////////////////////////////////////////////////////////////////////////////
/// ROUTES
/////////////////////////////////////////////////////////////////////////////////////////////

// Authentication and Authorization:
// In the following, we use "authenticated" to mean that the user has "logged in" to prove their identity,
// either with a username/password for our site, or with some external login that we recognize.
// The different kinds of logins are called "strategies".
// We use "authorized" to mean that authenticated user is allowed to make the specific request at hand,
// e.g., to change their own profile or composition, as opposed to someone else's.
router.use(passport.initialize());
passport.use(new BasicStrategy(function (username, password, done) {
    // When passport does not find a serialized user in the session cookie (if configured to use sessions),
    // it attempts to obtain the credentials based on the strategy.
    // If there are credentials, it invokes this callback to produce an authenticated user from the given credentials.
    // Improper credentials should a falsey user, not an error (which would indicate a machinery failure).
    // (Confusingly, the passport documentation calls this verifying, but by that they mean verifying the credentials
    // to produce an authenticated user. It does not verify that the user is authorized for the request, which isn't given here.)
    getMember(username, function (error, member, idtag) {
        var missing = store.doesNotExist(error);
        if (member) { member.idtag = idtag; }
        done(!missing && error,
             // We cannot authenticate the credentials against user password unless we resolve username to idtag, and
             // idtag to member data (which holds a hash of the password). Having done all this work, we might as well
             // then answer the whole member object (which will then be stored by passport within the req.user),
             // so that we don't have to look it up again in the route handler.
             !missing && (member.passwordHash === passwordHash(password, idtag)) && member);
    });
}));

// Generic route handler functions that we can use in a specific chain (instead of being applied all the time). See .post() calls, below.
// This route is is used in the route to determine whether the given authenticated user is authorized for the next step in the route.
var authenticate = passport.authenticate('basic', {session: false});
function authorizeForRequest(req, res, next) {
    ignore(res);
    if (req.user.username === req.params.username) { return next(); }
    return next(forbidden("Unauthorized " + req.user.username + " for " + req.params.username));
}
function rateLimit(req, res, next) {
    ignore(req, res); // Should probably also guard against overlapping request from same ip.
    setTimeout(next, 1000);
}

// route converts 'picture' form field to req.file (an object with 'path' property), and adds any text fields to req.body
// NOTE: To be parsed, the uploaded data must be multipart/form-data. If that data comes from an HTML form, the form
// must specify enctype="multipart/form-data".
var singleFileUpload = upload.single('picture');

// express has built-in machinery to server static files from the specified directory.
router.use('/media', express.static(media));

// As we add routes, below, the router arranges for parameters expressed in the routes (e.g., :idtag),
// and filled in in the actual URL of the request, to be added to the 'params' property of the request object.

// There are broadly two ways we can do updates for compositions and profiles:
// - The traditional ways is a special "update" URL that serves the existing content in input elements within a form.
//   When the user then submits the form, the data is POSTed to the same URL, and the route handler for that updates
//   the stored data.
// - Alternatively, we could just use the normal display URL, and have it contain an invisible version of the same input elements.
//   If the user hovers (or perhaps clicks) on the display version, it disappears and the input version appears.
//   The same POST can be made, either when all is done or after leaving each input box.
// We're going with the traditional way for now, but that might change.

//////////////////
// MEMBER PROFILE
//////////////////
function renderMember(username, view, res, next) {
    getMember(username, function (error, data) {
        if (error) { return next(error); }
        res.render(view, data);
    });
}
router.get('/member/:username/profile.html', function (req, res, next) {
    renderMember(req.params.username, 'member', res, next);
});
router.get('/update-member/new/profile.html', rateLimit, function (req, res, next) {
    ignore(req, next);
    res.render('updateMember', {newMember: true});
});
// A route can specify a chain of handlers to be applied, instead of just one.
router.get('/update-member/:username/profile.html', authenticate, authorizeForRequest, function (req, res, next) {
    ignore(req, next);
    res.render('updateMember', req.user);
});

var MINIMUM_LIFETIME_MILLISECONDS_PER_USERNAME_CHANGE = 24 * 60 * 60 * 1000;
// Normalize and merge into existing data, keeping everything consistent and verified (e.g., username nametags in store).
function updateMember(req, res, next) {
    ignore(next);
    var data = req.user || {idtag: uuid.v4()};
    var idtag = data.idtag;
    var oldUsername = data.username;
    function finish(error) {
        if (error) {
            data.error = error.message;
            data.newMember = !oldUsername;
            if (error.code) { res.statusCode = error.code; }
            return res.render('updateMember', data);
        }
        // FIXME: This is a lot of unnecessary round trips and lookups. For now, it's a good test that we got the parsing right.
        res.redirect('/member/' + data.username + '/profile.html');
    }
    function update(error) {
        if (error) { return finish(error); }
        handlePictureUpload(req.file, data, function (error) {
            if (error) { return finish(error); }
            delete data.idtag;  // idtag is in the docname. We don't keep it inside.
            store.set(memberIdtag2Docname(idtag), data, finish);
        });
    }
    // Merge in the data. Tests below depend on the data being normalized (e.g., empty space trimmed out).
    copyStringProperties(['title', 'description', 'website', 'email', 'username'], req.body, data);
    var password = normalize(req.body.password);
    if (password !== normalize(req.body.repeatPassword)) { return finish(badRequest("Password does not match.")); }
    if (password) { data.passwordHash = passwordHash(password, idtag); }
    if (!data.username || !data.title || !data.email || !data.passwordHash) { // Pun: catching both '' and undefined.
        // Won't happen through our form, but someone could send bad data directly.
        return finish(badRequest("Missing required data: " + JSON.stringify(req.body)));
    }
    if (data.username === oldUsername) { return update(); }
    // All the rest makes sure the new username is available.
    if (oldUsername) {
        if (!data.oldUsernames) { data.oldUsernames = []; }
        data.oldUsernames.push(oldUsername); // oldUsername can appear many times. Counts against "too many username changes"
        if (((Date.now() - data.created) / (data.oldUsernames.length + 1)) < MINIMUM_LIFETIME_MILLISECONDS_PER_USERNAME_CHANGE) {
            return finish(tooMany("Too many username changes."));
        }
    }
    var newUserDocname = memberNametag2Docname(data.username);
    store.get(newUserDocname, function (error, existing) {
        if (error && !store.doesNotExist(error)) { return finish(error); }
        if (existing && (existing !== idtag)) {
            return finish(conflict("Username " + data.username + " is already in use."));
        }
        store.set(newUserDocname, idtag, function (error) {
            if (error) { return finish(error); }
            if (oldUsername) { return update(); }
            data.created = Date.now();
            ensureMemberCollections(idtag, update);
        });
    });
}
router.post('/update-member/new/profile.html', rateLimit, singleFileUpload, updateMember);
router.post('/update-member/:username/profile.html', authenticate, authorizeForRequest, singleFileUpload, updateMember);
// We do not currently have a destroy member operation. There may be transactions involving the member.
// However, one can delete all one's UNSOLD compositions, and/or update your data to something not very meaningful.

//////////////////
// COMPOSITIONS
//////////////////

router.get('/art/:username/:compositionNametag.html', function (req, res, next) {
    getMemberComposition(req.params.username, req.params.compositionNametag, function (error, data) {
        if (error) { return next(error); }
        res.render('composition', data);
    });
});

router.get('/update-art/:username/:compositionNametag.html', authenticate, authorizeForRequest, function (req, res, next) {
    if (req.params.compositionNametag === 'new') {
        return res.render('updateComposition', {newComposition: true}); // Nothing to look up, but render same view as below.
    }
    getMemberComposition(req.params.username, req.params.compositionNametag, function (error, data) {
        if (error) { return next(error); }
        res.render('updateComposition', data);
    });
});

router.post('/update-art/:username/:compositionNametag.html', authenticate, authorizeForRequest, singleFileUpload, function (req, res, next) {
    var idtag = req.body.idtag || uuid.v4();
    var docName = compositionIdtag2Docname(idtag);
    function transformer(oldData, writerFunction) {
        if (!oldData && (req.body.compositionNametag === 'new')) {
            return writerFunction(unknown(req.params.username + " " + req.params.compositionNametag));
        }
        copyStringProperties(['title', 'description', 'price', 'dimensions', 'medium'], req.body, oldData);
        if (req.body.category) { oldData.category = req.body.category.split(' '); } // FIXME harden this
        handlePictureUpload(req.file, oldData, writerFunction); // oldData has now been modified
    }
    store.update(docName, undefined, transformer, function (error) {
        if (error) { return next(error); }
        // FIXME: This is a lot of unnecessary round trips and lookups. For now, it's a good test that we got the parsing right.
        res.redirect('/art/' + req.params.username + '/' + req.params.compositionNametag + '.html');
    });
});

//////////////////
// OTHER PAGES
//////////////////

router.get('/', function (req, res, next) {
    ignore(req, next);
    res.render('index');
});

module.exports = router;
