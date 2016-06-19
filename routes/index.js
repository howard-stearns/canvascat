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
var _ = require('underscore');
require('../polyfills');

/////////////////////////////////////////////////////////////////////////////////////////////
/// UTILITIES
/////////////////////////////////////////////////////////////////////////////////////////////
var DEFAULT_PARALLEL_LIMIT = 50;
var ignore = _.noop; // Does nothing, and used to document parameters that are deliberately not used.

function propertyPush(object, property, newElement, optionalCheck) { // object[property].push(newElement) even if undefined
    var array = object[property] || [];
    if (optionalCheck && newElement && array.includes(newElement)) { return; }
    array.push(newElement);
    object[property] = array;
}

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
function docname(collection, identifier) { return path.join(collection, identifier); }
function memberCollectionname(idtag) { return docname(members, idtag); }
function memberCompositionsCollectionname(idtag) {
    return path.join(members, idtag, 'compositionNametags');
}
function memberIdtag2Docname(idtag) {
    return docname(memberCollectionname(idtag), 'profile.json');
}
function compositionNametag2Docname(userIdtag, nametag) {
    return docname(memberCompositionsCollectionname(userIdtag), nametag);
}
function memberNametag2Docname(nametag) {
    return docname(memberNametags, nametag);
}
function compositionIdtag2Docname(idtag) {
    return docname(compositions, idtag + '.json');
}
function readablyEncode(nfkdString) { // Encode safely for a url, as readable as practical.
    var string = (nfkdString || '').toLowerCase();
    return encodeURIComponent(string).replace(/%../g, '+');
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
    if (code) { error.status = code; }
    return error;
}
function forbidden(message) { return makeError(message, 403); }
function forbiddenComposition(nametag) { return forbidden(nametag + " is not one of your compositions."); }
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
// ensure that collection/nametag points to idtag and call cb(error),
// where the pre-existence of collection/nametag pointing to a different idtag is an error.
function ensureUniqueNametag(collection, nametag, idtag, label, cb) {
    var document = docname(collection, nametag);
    store.get(document, function (error, existing) {
        if (existing === idtag) { return cb(); }
        if (existing) { error = conflict(label + " " + nametag + " is already in use."); }
        if (error && !store.doesNotExist(error)) { return cb(error); }
        store.set(document, idtag, cb);
    });
}

function resolveUsername(username, cb) { // cb(error, memberIdtag)
    store.get(memberNametag2Docname(username), cb);
}
function expandMember(idtag, cb) {
    store.get(memberIdtag2Docname(idtag), function (error, member) {
        if (error) { return cb(error); }
        member.pictureUrl = member.picture ? mediaUrl(member.picture) : defaultMemberPictureUrl;
        member.url  = '/member/' + member.username + '/profile.html';
        member.updateUrl = '/update-member/' + member.username + '/profile.html';
        member.addCompositionUrl = '/update-art/' + member.username + '/new.html';
        if (!member.firstname && !member.lastname) {
            var split = member.title.split(' ');
            member.firstname = split[0];
            member.lastname = split.slice(1).join(' ');
        }
        cb(null, member, idtag);
    });
}
function getMember(username, cb) { // cb(error, memberData, memberIdtag)
    resolveUsername(username, function (error, idtag) {
        if (error) { return cb(error); }
        expandMember(idtag, cb);
    });
}
function resolveCompositionName(memberIdtag, compositionNametag, cb) { //cb(error, compositionIdtag)
    store.get(compositionNametag2Docname(memberIdtag, compositionNametag), cb);
}
function getMemberComposition(member, memberIdtag, compositionNametag, cb) { // cb(error, compositionData), with artist data resolved
    resolveCompositionName(memberIdtag, compositionNametag, function (error, idtag) {
        if (error) { return cb(error); }
        store.getWithModificationTime(compositionIdtag2Docname(idtag), function (error, composition, modtime) {
            if (error) { return cb(error); }
            composition.pictureUrl = mediaUrl(composition.picture);
            composition.url = '/art/' + member.username + '/' + composition.nametag + '.html';
            composition.updateUrl = '/update-art/' + member.username + '/' + composition.nametag + '.html';
            composition.addCompositionUrl = member.addCompositionUrl;
            composition.artist = member;
            composition.modified = modtime.getTime();
            if (composition.buyer) {
                expandMember(composition.buyer, function (error, buyer) {
                    composition.buyer = buyer;
                    cb(error, composition, idtag);
                });
            } else {
                cb(null, composition, idtag);
            }
        });
    });
}
function getUsernameComposition(username, compositionNametag, cb) { // cb(error, compositionData), with artist data resolved
    getMember(username, function (error, member, memberIdtag) {
        if (error) { return cb(error); }
        getMemberComposition(member, memberIdtag, compositionNametag, cb);
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
// writerFunction(error, data, data) is called, so that a store.update writerFunction has access to data even when an error.
function handlePictureUpload(file, data, writerFunction) {
    function cb(error) { writerFunction(error, data, data); }
    function mediaPath(idtag) { return path.join(media, idtag); }
    if (!file) { return setImmediate(cb); }
    var extension = path.extname(file.originalname).toLowerCase();
    file.mimetype = file.mimetype.toLowerCase();
    if (extension === '.jpg') { extension = '.jpeg'; }
    if (file.mimetype === 'image/jpg') { file.mimetype = 'image/jpeg'; }
    if (file.mimetype !== 'image/' + extension.slice(1)) {
        return writerFunction(badRequest('File extension "' + extension + '" does not match mimetype "' + file.mimetype + '".'), data, data);
    }
    fs.readFile(file.path, function (error, buffer) {
        if (error) { return writerFunction(error, data, data); }
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
    // We could issue tooMany(), but we currently just delay the handling a bit.
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
    res.render('updateMember', {newMember: true}); // tells template that different fields are requried
});
// A route can specify a chain of handlers to be applied, instead of just one.
router.get('/update-member/:username/profile.html', authenticate, authorizeForRequest, function (req, res, next) {
    ignore(req, next);
    res.render('updateMember', req.user);
});

var MINIMUM_MILLISECONDS_BETWEEN_NAME_CHANGES = 60 * 60 * 1000;
var MAX_NAME_CHANGES = 50;
// Normalize and merge into existing data, keeping everything consistent and verified (e.g., username nametags in store).
function updateMember(req, res, next) {
    ignore(next);
    // We don't get/set old data using store.update, because authentication already grabbed any old data as req.user.
    var data = req.user || {idtag: uuid.v4()}; // will accumulate the final answer
    var newData = req.body;
    var idtag = data.idtag;
    var oldUsername = data.username;
    function finish(error) {
        if (error) {
            data.error = error.message;
            data.newMember = !oldUsername; // indicates which fields are required
            if (error.status) { res.statusCode = error.status; }
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
    copyStringProperties(['title', 'description', 'website', 'email', 'username'], newData, data);
    data.username = readablyEncode(data.username);
    var password = newData.password;
    if (password !== newData.repeatPassword) { return finish(badRequest("Passwords do not match.")); }
    if (password) { data.passwordHash = passwordHash(password, idtag); }
    // Design choice: we check the combined data, not just the newData. No difference when going through a
    // a Web page form with default values, checking the combined data is more accepting as an API.
    var missing; // Pun: we catch both '' and undefined.
    ['passwordHash', 'email', 'username', 'title'].forEach(function (name) { if (!data[name]) { missing = name; } });
    if (missing) {
        // Won't happen through our form, but someone could send bad data directly.
        return finish(badRequest("Missing required data: " + missing));
    }
    if (data.username === oldUsername) { return update(); }
    // All the rest makes sure the new username is available.
    if (oldUsername) {
        var now = Date.now();
        // data.oldUsernames is a map of timestamp => oldUsername, giving us a history of which (possibly repeated) name
        // was used when. Here we store the data, and also check that the last change was not too recent.
        // We currently only make use of the last timestamp and, for deletion, the set of names.
        if (data.oldUsernames) {
            var changes = Object.keys(data.oldUsernames);
            if ((changes.length > MAX_NAME_CHANGES) || ((now - parseInt(_.last(changes), 10)) < MINIMUM_MILLISECONDS_BETWEEN_NAME_CHANGES)) {
                return finish(tooMany("Too many username changes."));
            }
        } else {
            data.oldUsernames = {};
        }
        data.oldUsernames[now] = oldUsername;
    }
    ensureUniqueNametag(memberNametags, data.username, idtag, 'Username', function (error) {
        if (error) { return finish(error); }
        if (oldUsername) { return update(); }
        data.created = Date.now();
        ensureMemberCollections(idtag, update);
    });
}
// Two different routes because the authentication is different for a new profile vs changing an existing profile.
router.post('/update-member/new/profile.html', rateLimit, singleFileUpload, updateMember);
router.post('/update-member/:username/profile.html', authenticate, authorizeForRequest, singleFileUpload, updateMember);

// For internal (testing) use only. Composition must be cleaned up separately.
router.delete('/member/:username/profile.html', function (req, res, next) {
    if ((req.ip !== '::1') && (req.headers.host !== 'localhost:3000')) {
        return next(forbidden('Local delete only'));
    }
    getMember(req.params.username, function (error, data, idtag) {
        if (error) { return next(error); } // Cannot go further
        async.each((_.values(data.oldUsernames || {})).concat(data.username).map(memberNametag2Docname), store.destroy, function (error) {
            if (error) { console.log('nametag cleanup', error); } // log it and move on
            store.destroyCollection(memberCollectionname(idtag), function (error) {
                if (error) { return next(error); }
                res.send('ok');
            });
        });
    });
});
//////////////////
// COMPOSITIONS
//////////////////

router.get('/art/:username/:compositionNametag.html', function (req, res, next) {
    getUsernameComposition(req.params.username, req.params.compositionNametag, function (error, data) {
        if (error) { return next(error); }
        res.render('composition', data);
    });
});

// This is a little different from member, in that compositions are always owned by someone (even new compositions), and
// we have to check that old composition changes are to a composition belonging to that user.
router.get('/update-art/:username/:compositionNametag.html', authenticate, authorizeForRequest, function (req, res, next) {
    var member = req.user;
    if (req.params.compositionNametag === 'new') {
        return res.render('updateComposition', {
            newComposition: true,
            category: [],
            artist: member
        }); // Nothing to look up, but render same view as below.
    }
    var nametag = req.params.compositionNametag;
    getMemberComposition(member, member.idtag, nametag, function (error, data, idtag) {
        if (error) { return next(error); }
        if (!member.artistCompositions.includes(idtag)) {
            return next(forbiddenComposition(nametag));
        }
        res.render('updateComposition', data);
    });
});

router.post('/update-art/:username/:compositionNametag.html', authenticate, authorizeForRequest, singleFileUpload, function (req, res, next) {
    var nametag = req.params.compositionNametag,
        newComposition = (nametag === 'new'),
        member = req.user;
    function update(idtag) {
        var docName = compositionIdtag2Docname(idtag);
        function transformer(data, writerFunction) {
            if (!data && !newComposition) {
                return writerFunction(unknown(member.username + " " + nametag), data, data);
            }
            var oldNametag = data.nametag;
            copyStringProperties(['title', 'description', 'price', 'dimensions', 'medium'], req.body, data);
            nametag = data.nametag = readablyEncode(data.title);
            if (req.body.category) { data.category = req.body.category.split(' '); } // FIXME harden this
            if (newComposition) { data.created = Date.now(); }
            if (oldNametag === data.nametag) {
                return handlePictureUpload(req.file, data, writerFunction);
            }
            ensureUniqueNametag(memberCompositionsCollectionname(member.idtag), nametag, idtag, 'Composition nametag', function (error) {
                if (error) { return writerFunction(error, data, data); }
                propertyPush(data, 'oldNametags', oldNametag, true); // keep track of old so that we can clean up when deleting composition
                handlePictureUpload(req.file, data, writerFunction);
            });
        }
        store.update(docName, {}, transformer, function (error, data) { // data comes from third arg to writerFunction
            if (error) {
                data.error = error.message;
                if (error.status) { res.statusCode = error.status; }
                data.artist = member;
                return res.render('updateComposition', data);
            }
            // FIXME: This is a lot of unnecessary round trips and lookups. For now, it's a good test that we got the parsing right.
            var url = '/art/' + member.username + '/' + nametag + '.html';
            res.redirect(url);
        });
    }
    if (newComposition) {
        var idtag = uuid.v4();
        function addComposition(oldData, writerFunction) {
            propertyPush(oldData, 'artistCompositions', idtag);
            writerFunction(null, oldData);
        }
        store.update(memberIdtag2Docname(member.idtag), undefined, addComposition, function (error) {
            if (error) { return next(error); }
            update(idtag); // It's possible that this will fail, leaving a dangling pointer in member compositions. Fine...
        });
    } else {
        resolveCompositionName(member.idtag, nametag, function (error, idtag) {
            // If it doesn't exist, it cannot be one of ours. No point in preserving form data.
            if (error) { return next(store.doesNotExist(error) ? forbiddenComposition(nametag) : error); }
            update(idtag);
        });
    }
});

//////////////////
// OTHER PAGES
//////////////////

router.get(/^\/(index.html)?$/, function (req, res, next) {
    ignore(req, next);
    res.render('index');
});

module.exports = router;
