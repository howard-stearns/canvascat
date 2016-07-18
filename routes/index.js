"use strict";
/*jslint node: true, nomen: true, vars: true, plusplus: true*/

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
var ignore = _.noop; // Does nothing, and used to document parameters that are deliberately not used.

function secret(key) {   // Grab a secret from the shell environment, or report that it wasn't set.
    if (process.env[key]) { return process.env[key]; }
    throw new Error("Please set environment variable: export " + key + "=theSecretValue");
}
var passwordSecret = secret('PASSWORD_SECRET');
function passwordHash(password, idtag) {
    return crypto.createHmac('sha256', passwordSecret).update(password).update(idtag).digest('hex');
}
function readablyEncode(nfkdString) { // Encode safely for a url, as readable as practical.
    var string = (nfkdString || '').replace(/[\u0300-\u036f]/g, '').toLowerCase(); // remove diacriticals
    return encodeURIComponent(string).replace(/%../g, '+');
}

// join and resolve are method in the path module, which build up pathnames in the file system.
// join simply concatenates the arguments together with the file system separator in between.
// resolve fixes things up to produce an absolute pathname from root.
var db = path.resolve(__dirname, '..', '..', 'db');  // __dirname is this directory, and is built into node.
var members = path.join(db, 'members');
var memberNametags = path.join(db, 'memberNametags');
var compositions = path.join(db, 'compositions');
var media = path.join(db, 'media');
function mediaPath(idtag) { return path.join(media, idtag); }
function docname(collection, identifier) { return path.join(collection, identifier); }
function memberCollectionname(idtag) { return docname(members, idtag); }
function memberCompositionsCollectionname(idtag) {
    return path.join(members, idtag, 'compositionNametags');
}
// Each member and composition each has an idtag that never changes.
// We use the idtag for internal references (e.g., member.artistComposition), and within scroll urls.
// These functions map the idtag to the appropriate document within our persistent store (e.g., file system).
// 
function memberIdtag2Docname(idtag) {
    return docname(memberCollectionname(idtag), 'profile.json');
}
function compositionIdtag2Docname(idtag) {
    return docname(compositions, idtag + '.json');
}
// However, we arrange for users and search engines to see a more mnemonic canonical URL using nametags.
// Each member has a globally unique username that maps to a member idtag,
// and each composition has a nametag that is unique among that artist's compositions.
// E.g., /member/username/profile.html, and /art/username/compositionNametag.html
// Each nametag maps to a document whose sole content is the idtag to use.
function memberNametag2Docname(nametag) {
    return docname(memberNametags, nametag);
}
function compositionNametag2Docname(userIdtag, nametag) {
    return docname(memberCompositionsCollectionname(userIdtag), nametag);
}
function ensureMemberCollections(idtag, cb) { // member collection also contains a collection of composition nametags
    store.ensureCollection(memberCollectionname(idtag), function (error) {
        if (error) { return cb(error); }
        store.ensureCollection(memberCompositionsCollectionname(idtag), cb);
    });
}
// The file extension is already part of the idtag.
function mediaUrl(idtag) {
    // Even though the results would be the same if we used path.join, here we are returning a
    // (relative) URL, so join is not really expressing what we want. Our URLs always use slashes
    // as separators.
    return '/media/' + idtag;
}
var defaultMemberPictureUrl = mediaUrl('default-member.gif');
// An object that has utilities to parse  multi-part file uploads and place them in uploads directory.
var upload = multer({dest: path.resolve(__dirname, '..', '..', 'uploads')});

// Errors
function makeError(message, code) { // optional code is stored in the error for use as the HTTP response code.
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
// There are two ways to work with objects that have properties defined:
// 1. Always define the properties, so that uses of the object can just assume that it is there.
// 2. Add the property only when it is needed - i.e., when it becomes non-empty or non-default.
// We do the latter, so that we can flexibly add things later.
// FIXME: make member objects and composition objects with getters that provide what's needed
function propertyPush(object, property, newElement, optionalCheck) { // object[property].push(newElement) even if undefined
    var array = object[property] || [];
    if (optionalCheck && newElement && array.includes(newElement)) { return; }
    array.push(newElement);
    object[property] = array;
}

// Scores are exponential decays, represented internally as {N0: aNumberAtTime0, T0: theTimestampAtTime0}
var SCORE_NEGATIVE_INVERSE_HALF_LIFE_MILLISECONDS = -1 / (30 * 24 * 60 * 60 * 1000); // -1 / 30 day-half-life
function getCurrentScore(object, optionalNow) { // answer current value of an object's score, allowing for time decay
    var score = object.score;
    if (!score) { return 0; }
    var now = optionalNow || Date.now();
    return score.N0 * Math.pow(2, (now - score.T0) * SCORE_NEGATIVE_INVERSE_HALF_LIFE_MILLISECONDS);
}
function addScore(object, increment) { // Update object's score by increment
    var now = Date.now();
    object.score = {N0: getCurrentScore(object, now) + increment, T0: now};
}

var MINIMUM_MILLISECONDS_BETWEEN_NAME_CHANGES = 60 * 60 * 1000;
var MAX_NAME_CHANGES = 50;
// Ensure that collection/nametag points to idtag and call cb(error),
// where the pre-existence of collection/nametag pointing to a different idtag is an error.
// Side-effects data with info about oldNametag.
function ensureUniqueNametag(collection, nametag, idtag, oldNametag, data, label, cb) {
    var document = docname(collection, nametag);
    if (oldNametag) {
        var now = Date.now();
        // data.oldNametags is a map of timestamp => oldUsername, giving us a history of which (possibly repeated) name
        // was used when. Here we store the data, and also check that the last change was not too recent.
        // We currently only make use of the last timestamp and, for deletion, the set of names.
        if (data.oldNametags) {
            var changes = Object.keys(data.oldNametags);
            if ((changes.length > MAX_NAME_CHANGES) || ((now - parseInt(_.last(changes), 10)) < MINIMUM_MILLISECONDS_BETWEEN_NAME_CHANGES)) {
                return cb(tooMany("Too many username changes."));
            }
        } else {
            data.oldNametags = {};
        }
        data.oldNametags[now] = oldNametag;
    }
    store.update(document, null, function (existing, writerFunction) { // update, so that overlapping activity is atomic
        if (existing === idtag) { return writerFunction(); }
        if (existing) { return writerFunction(conflict(label + " " + nametag + " is already in use.")); }
        writerFunction(null, idtag);
    }, cb);
}

function resolveUsername(username, cb) { // cb(error, memberIdtag)
    store.get(memberNametag2Docname(username), cb);
}
function expandMember(member) { // side-effects member with more data used by templates
    member.pictureUrl = member.picture ? mediaUrl(member.picture) : defaultMemberPictureUrl;
    member.url  = '/member/' + member.username + '/profile.html';
    member.updateUrl = '/update-member/me/profile.html';
    member.addCompositionUrl = '/update-art/' + member.username + '/new.html';
    if (!member.firstname && !member.lastname) {
        var split = member.name.split(' ');
        member.firstname = split[0];
        member.lastname = split.slice(1).join(' ');
    }
    return member;
}
function getMemberByIdtag(memberIdtag, cb) { // cb(error, memberData, memberIdtag)
    store.get(memberIdtag2Docname(memberIdtag), function (error, member) {
        cb(error, member, memberIdtag);
    });
}
function getMember(username, cb) { // cb(error, memberData, memberIdtag)
    resolveUsername(username, function (error, idtag) {
        if (error) { return cb(error); }
        getMemberByIdtag(idtag, cb);
    });
}
function resolveCompositionName(memberIdtag, compositionNametag, cb) { //cb(error, compositionIdtag)
    store.get(compositionNametag2Docname(memberIdtag, compositionNametag), cb);
}
function relatedCompositionUrl(dataset, memberIdtag, compositionIdtag, increment) {
    var compositions = dataset.artistCompositions; // FIXME: long list
    if (!compositions) { return; }
    var index = compositionIdtag ? compositions.indexOf(compositionIdtag) : (compositions.length - 1),
        nextIndex = index + (increment || 0),
        next = compositions[nextIndex];
    return next && path.join('/artscroll', memberIdtag || dataset.artists[nextIndex], next);
}
var hot; // FIXME: long list
var hotlistIdtag = docname(path.join(db, 'hotlist'), 'data');
function getHot(cb) {
    if (hot) { return setImmediate(function () { cb(null, hot); }); }
    store.get(hotlistIdtag, function (error, data) {
        if (store.doesNotExist(error)) {
            data = {artistCompositions: [], artists: []};
            error = null;
        }
        hot = data;
        cb(error, data);
    });
}
function addHot(memberIdtag, compositionIdtag, cb) {
    getHot(function (error, hotlist) {
        if (error) { return cb(error); }
        hotlist.artists.push(memberIdtag);
        hotlist.artistCompositions.push(compositionIdtag);
        store.set(hotlistIdtag, hotlist, cb);
    });
}
function removeHot(compositionIdtag, cb) {
    getHot(function (error, hotlist) {
        var nextArt = [], nextMembers = [], i, comp, length = hotlist.artists.length;
        if (error) { return cb(error); }
        for (i = 0; i < length; i++) {
            comp = hotlist.artistCompositions[i];
            if (comp !== compositionIdtag) {
                nextArt.push(comp);
                nextMembers.push(hotlist.artists);
            }
        }
        hotlist.artistCompositions = nextArt;
        hotlist.artists = nextMembers;
        store.set(hotlistIdtag, hotlist, cb);
    });
}
function getMemberCompositionByIdtag(member, memberIdtag, compositionIdtag, cb) { // cb(error, expandedCompositionData, compositionIdtag), with artist data resolved
    expandMember(member);
    store.getWithModificationTime(compositionIdtag2Docname(compositionIdtag), function (error, composition, modtime) {
        if (error) { return cb(error); }
        composition.pictureUrl = mediaUrl(composition.picture);
        composition.url = '/art/' + member.username + '/' + composition.nametag + '.html';
        composition.updateUrl = '/update-art/' + member.username + '/' + composition.nametag + '.html';
        composition.addCompositionUrl = member.addCompositionUrl;
        composition.artist = member;
        composition.modified = modtime.getTime();
        composition.previousFromArtist = relatedCompositionUrl(member, memberIdtag, compositionIdtag, -1);
        composition.nextFromArtist = relatedCompositionUrl(member, memberIdtag, compositionIdtag, 1);
        getHot(function (error, hot) {
            if (error) { return cb(error); }
            composition.previousHot = relatedCompositionUrl(hot, null, compositionIdtag, -1);
            composition.nextHot = relatedCompositionUrl(hot, null, compositionIdtag, 1);
            if (composition.buyer) {
                getMember(composition.buyer, function (error, buyer) {
                    composition.buyer = buyer;
                    cb(error, composition, compositionIdtag);
                });
            } else {
                cb(null, composition, compositionIdtag);
            }
        });
    });
}
function getMemberComposition(member, memberIdtag, compositionNametag, cb) {
    resolveCompositionName(memberIdtag, compositionNametag, function (error, compositionIdtag) {
        if (error) { return cb(error); }
        getMemberCompositionByIdtag(member, memberIdtag, compositionIdtag, cb);
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
// to reference it, and then cb(error). No-op (other than cb()) if file is not supplied.
// writerFunction(error, data, data) is called, so that a store.update writerFunction has access to data even when an error.
// It is our job to clean up unused files.
function handlePictureUpload(file, data, writerFunction) {
    function cb(error) { writerFunction(error, data, data); }
    function unlinker(path, finisher, existingError) {
        fs.unlink(path, function (error) {
            if (error) { console.log("No image at " + path); }
            finisher(existingError); // without error
        });
    }
    if (!file) { return setImmediate(cb); }
    var extension = path.extname(file.originalname).toLowerCase();
    file.mimetype = file.mimetype.toLowerCase();
    if (extension === '.jpg') { extension = '.jpeg'; }
    if (file.mimetype === 'image/jpg') { file.mimetype = 'image/jpeg'; }
    if (file.mimetype !== 'image/' + extension.slice(1)) {
        return unlinker(file.path, cb, badRequest('File extension "' + extension + '" does not match mimetype "' + file.mimetype + '".'));
    }
    fs.readFile(file.path, function (error, buffer) {
        if (error) { return cb(error); }
        var idtag = crypto.createHash('sha256').update(buffer).digest('hex') + extension,
            target = mediaPath(idtag);
        function finish() {
            data.picture = idtag;
            store.rename(file.path, target, cb);
        }
        if (data.picture) { // Remove old picture file. If two people use the same picture from the Internet,
            // and one changes, the other person will lose their picture!
            unlinker(mediaPath(data.picture), finish);
        } else {
            finish();
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
    // Improper credentials should produce a falsey user, not an error (which would indicate a machinery failure).
    // (Confusingly, the passport documentation calls this verifying, but by that they mean verifying the credentials
    // to produce an authenticated user. It does not verify that the user is authorized for the request, which isn't done here.)
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
// This route respects login if the credentials were provided in the request, but does not fail/401 if not provided.
function allowAuthenticate(req, res, next) {
    if (!req.headers.authorization) { return next(); }
    authenticate(req, res, next);
}
function authorizeForRequest(req, res, next) {
    var key, user = req.user, username = req.params.username;
    ignore(res);
    if (user.username === username) { return next(); }
    if (user.oldNametags) {
        for (key in user.oldNametags) {
            if (user.oldNametags[key] === username) { return next(); }
        }
    }
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
router.get('/member/:username/profile.html', allowAuthenticate, function (req, res, next) {
    getMember(req.params.username, function (error, member, memberIdtag) {
        if (error) { return next(error); }
        member.previousFromArtist = relatedCompositionUrl(member, memberIdtag);
        member.favorable = !req.user || !_.contains((req.user.favoredMembers || []), memberIdtag); // req.user comes from allowAuthenticate
        res.render('member', expandMember(member));
    });
});
router.post('/member/:username/profile.html', authenticate, function (req, res, next) {
    // Currently only hanldes "favor", whereas general update is a separate form obtained from /update-member/me/profile.html.
    // In the favor case, the authenticated user and the favored user are (likely) different, and both are modified.
    // We ensure that you can like me and vice versa at the same time, without deadlock.
    if (!req.body.favor) { return next(badRequest("No recognized action")); }
    resolveUsername(req.params.username, function (error, favoredIdtag) { // Make sure the favored member exists. (usernames never expire)
        if (error) { return next(error); }
        // Even thought we already have the favorer through authentication, we want to test and store the action as a single atomic
        // action, so that overlapping parallel likes only happen once. (authenticate() doesn't lock the user record.)
        store.update(memberIdtag2Docname(req.user.idtag), null, function (favorer, writeFavorer) {
            if (!favorer) { return writeFavorer(unknown(req.user.username)); } // Can't really happen, because of auth.
            var favoredMembers = favorer.favoredMembers; // FIXME: long list
            if (!favoredMembers) { favorer.favoredMembers = favoredMembers = []; }
            if (_.contains(favoredMembers, favoredIdtag)) { return writeFavorer(tooMany(req.params.username + " is already favored.")); }
            favoredMembers.push(favoredIdtag);
            // At this point, the only thing that go wrong is a system error.
            writeFavorer(null, favorer);
        }, function (error) {
            if (error) { return next(error); }
            store.update(memberIdtag2Docname(favoredIdtag), null, function (favored, writeFavored) {
                if (!favored) { return writeFavored(unknown(req.params.username)); } // Can't really happen, becuase of resolveUsername
                addScore(favored, 5); // favoring a member is worth 5
                writeFavored(null, favored);
            }, function (error) {
                if (error) { return next(error); }
                res.send('ok');
            });
        });
    });
});
// A route can specify a chain of handlers to be applied, instead of just one.
router.get('/update-member/new/profile.html', rateLimit, function (req, res, next) {
    ignore(req, next);
    res.render('updateMember', {newMember: true}); // tells template that different fields are requried
});
router.get('/update-member/me/profile.html', authenticate, function (req, res, next) {
    ignore(req, next);
    res.render('updateMember', req.user);
});

function missingProperties(requiredProperties, data, cb) { // true if any missing and cb(err, {}, {}) was used, else false
    // requiredProperties should be written with the most important ones last.
    // Passes {} as tertiary arg to cb for compatability with how update writerFunction is used.
    //
    // Design choice: we check the combined data, not just the newData. No difference when going through a
    // a Web page form with default values, checking the combined data is more accepting as an API.
    var missing; // Pun: we catch both '' and undefined.
    requiredProperties.forEach(function (name) { if (!data[name]) { missing = name; } });
    if (missing) {
        // Won't happen through our form, but someone could send bad data directly.
        cb(badRequest("Missing required data: " + missing), {}, {});
        return true;
    }
}

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
        // Questionable design choice: Any errors at this point are system errors, not client errors, and so we don't
        // expect them to happen in normal operation, and we do not clean up media or nametags already in position.
        // (Same issue with composition update.)
        if (error) { return finish(error); }
        handlePictureUpload(req.file, data, function (error) {
            if (error) { return finish(error); }
            delete data.idtag;  // idtag is in the docname. We don't keep it inside.
            // We're not worried about making the read and write atomic (with update instead of set), because
            // people are not allowed to share accounts. If they do, or if a user has overlapping changes from multiple devices,
            // the last one wins.
            store.set(memberIdtag2Docname(idtag), data, finish);
        });
    }
    // Merge in the data. Tests below depend on the data being normalized (e.g., empty space trimmed out).
    copyStringProperties(['name', 'description', 'website', 'email', 'username'], newData, data);
    data.username = readablyEncode(data.username);
    var password = newData.password;
    if (password !== newData.repeatPassword) { return finish(badRequest("Passwords do not match.")); }
    if (password) { data.passwordHash = passwordHash(password, idtag); }
    if (missingProperties(['passwordHash', 'email', 'username', 'name'], data, finish)) { return; }
    if (data.username === oldUsername) { return update(); }
    // All the rest makes sure the new username is available.
    ensureUniqueNametag(memberNametags, data.username, idtag, oldUsername, data, 'Username', function (error) {
        if (error) { return finish(error); }
        if (oldUsername) { return update(); }
        data.created = Date.now();
        ensureMemberCollections(idtag, update);
    });
}
// Two different routes because the authentication is different for a new profile vs changing an existing profile.
router.post('/update-member/new/profile.html', rateLimit, singleFileUpload, updateMember);
router.post('/update-member/me/profile.html', authenticate, singleFileUpload, updateMember);


//////////////////
// COMPOSITIONS
//////////////////

router.get('/art/:username/:compositionNametag.html', function (req, res, next) { // canonical composition URL
    getMember(req.params.username, function (error, member, memberIdtag) {
        if (error) { return next(error); }
        getMemberComposition(member, memberIdtag, req.params.compositionNametag, function (error, composition) {
            if (error) { return next(error); }
            res.render('composition', composition);
        });
    });
});
// Less lookup, when appearing in a scroll of art by a given artist.
router.get('/artscroll/:memberIdtag/:compositionIdtag', function (req, res, next) {
    getMemberByIdtag(req.params.memberIdtag, function (error, member) {
        if (error) { return next(error); }
        getMemberCompositionByIdtag(member, req.params.memberIdtag, req.params.compositionIdtag, function (error, composition) {
            if (error) { return next(error); }
            res.render('composition', composition);
        });
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
        if (!member.artistCompositions.includes(idtag)) { // FIXME: long list
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
            function addCompositionToMember(oldMemberData, cb) {
                propertyPush(oldMemberData, 'artistCompositions', idtag); // FIXME: long list
                cb(null, oldMemberData);
            }
            function finish(error) {
                if (error) { return writerFunction(error, data, data); }
                if (!newComposition) { return writerFunction(null, data, data); }
                // Update the artist with the new composition 
                store.update(memberIdtag2Docname(member.idtag), undefined, addCompositionToMember, function (error) {
                    if (error) { return writerFunction(error, data, data); }
                    // And the hotlist
                    addHot(member.idtag, idtag, function (error) {
                        writerFunction(error, data, data); // composition data, not the member data from store.update.
                    });
                });
            }
            if (!data && !newComposition) {
                return writerFunction(unknown(member.username + " " + nametag), data, data);
            }
            var oldNametag = data.nametag;
            copyStringProperties(['name', 'description', 'price', 'dimensions', 'medium'], req.body, data);
            nametag = data.nametag = readablyEncode(data.name);
            if (req.body.category) { data.category = req.body.category.split(' '); } // FIXME harden this
            if (missingProperties(['medium', 'dimensions', 'price', 'name'], data, writerFunction)) { return; }
            if (newComposition) { data.created = Date.now(); }
            if (oldNametag === data.nametag) {
                return handlePictureUpload(req.file, data, finish);
            }
            ensureUniqueNametag(memberCompositionsCollectionname(member.idtag), nametag, idtag, oldNametag, data, 'Composition nametag', function (error) {
                if (error) { return writerFunction(error, data, data); }
                handlePictureUpload(req.file, data, finish);
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
        update(uuid.v4());
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
    ignore(req);
    getHot(function (error, hot) {
        if (error) { return next(error); }
        res.render('index', {latest: relatedCompositionUrl(hot)});
    });
});


// For internal (testing) use only. Composition must be cleaned up separately.
function deleteAuth(req, res, next) {
    ignore(res);
    if ((req.ip !== '::1') && (req.headers.host !== 'localhost:3000')) {
        return next(forbidden('Local delete only'));
    }
    next();
}
function makeOpHandler(res, next) { // answer handler that will send 'ok' or give error
    return function (error) {
        if (error) { return next(error); }
        res.send('ok');
    };
}
router.delete('/member/:username/profile.html', deleteAuth, function (req, res, next) {
    getMember(req.params.username, function (error, data, idtag) {
        if (error) { return next(error); } // Cannot go further
        var nametags = (_.values(data.oldNametags || {})).concat(data.username);
        var docs = nametags.map(memberNametag2Docname);
        async.each(docs, store.destroy, function (error) {
            if (error) { console.log('nametag cleanup', error); } // log it and move on
            store.destroyCollection(memberCollectionname(idtag), makeOpHandler(res, next));
        });
    });
});
router.delete('/art/:username/:nametag.html', deleteAuth, function (req, res, next) {
    getMember(req.params.username, function (error, data, memberIdtag) {
        ignore(data);
        if (error) { return next(error); } // Cannot go further
        resolveCompositionName(memberIdtag, req.params.nametag, function (error, idtag) {
            if (error) { return next(error); }
            removeHot(idtag, function (error) {
                if (error) { return next(error); }
                // No need to destroy old nametags as they are part of the member collection, which we destroy separately.
                // If we decide to allow deleting compositions without deleting the member, we would need to fix that,
                // and also update the artist and buyer data.
                store.destroy(compositionIdtag2Docname(idtag), makeOpHandler(res, next));
            });
        });
    });
});
router.delete('/media/:idtag', deleteAuth, function (req, res, next) {
    ignore(req);
    fs.unlink(mediaPath(req.params.idtag), makeOpHandler(res, next));
});

module.exports = router;
