"use strict";
/*jslint node: true, nomen: true, vars: true*/

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var store = require('ki1r0y.fs-store');
var multer  = require('multer');
var express = require('express');
var router = express.Router();

// join and resolve are method in the path module, which build up pathnames in the file system.
// join simply concatenates the arguments together with the file system separator in between.
// resolve fixes things up to produce an absolute pathname from root.
var db = path.resolve(__dirname, '..', '..', 'db');  // __dirname is this directory, and is built into node.
var members = path.join(db, 'members');
var memberNametags = path.join(db, 'memberNametags');
var compositions = path.join(db, 'compositions');
var media = path.join(db, 'media');
function memberNametag2Docname(nametag) {
    return path.join(memberNametags, nametag);
}
function memberIdtag2Docname(idtag) {
    return path.join(members, idtag, 'profile.json');
}
function compositionNametag2Docname(userIdtag, nametag) {
    return path.join(members, userIdtag, 'compositionNametags', nametag);
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
// parses multi-part file uploads and places them in uploads directory.
var upload = multer({dest: path.resolve(__dirname, '..', '..', 'uploads')});
// route converts 'picture' form field to req.file (an object with 'path' property), and adds any text fields to req.body
// NOTE: To be parsed, the uploaded data must be multipart/form-data. If that data comes from an HTML form, the form
// must specify enctype="multipart/form-data".
var singleFileUpload = upload.single('picture');

function getMember(username, cb) {
    store.get(memberNametag2Docname(username), function (error, idtag) {
        if (error) { return cb(error); }
        store.get(memberIdtag2Docname(idtag), function (error, member) {
            if (error) { return cb(error); }
            member.pictureUrl = member.picture ? mediaUrl(member.picture) : defaultMemberPictureUrl;
            member.idtag = idtag;
            member.url  = '/member/' + member.username + '/profile.html';
            member.updateUrl = '/update-member/' + member.username + '/profile.html';
            if (!member.firstname && !member.lastname) {
                var split = member.title.split(' ');
                member.firstname = split[0];
                member.lastname = split.slice(1).join(' ');
            }
            cb(null, member);
        });
    });
}
function getMemberComposition(username, compositionNametag, cb) {
    getMember(username, function (error, member) {
        if (error) { return cb(error); }
        store.get(compositionNametag2Docname(member.idtag, compositionNametag), function (error, idtag) {
            if (error) { return cb(error); }
            store.getWithModificationTime(compositionIdtag2Docname(idtag), function (error, composition, modtime) {
                if (error) { return cb(error); }
                composition.pictureUrl = mediaUrl(composition.picture);
                composition.idtag = idtag;
                composition.url = '/art/' + member.username + '/' + composition.nametag + '.html';
                composition.updateUrl = '/update-art/' + member.username + '/' + composition.nametag + '.html';
                composition.artist = member;
                composition.modified = modtime.getTime();
                cb(null, composition);
            });
        });
    });
}
function copyStringProperties(expectedProperties, from, to) { // copy only the listed properties if they have values in 'from'.
    expectedProperties.forEach(function (property) {
        var newValue = from[property];
        if (newValue !== undefined) { to[property] = newValue; }
    });
}
function unknown(nametag) { // Answer a reasonable error object
    return new Error('Unknown ' + nametag);
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
        return writerFunction(new Error('File extension "' + extension + '" does not match mimetype "' + file.mimetype + '".'));
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


// express has built-in machinery to server static files from the specified directory.
router.use('/media', express.static(media));

// As we add routes, below, the router arranges for parameters expressed in the routes (e.g., :idtag),
// and filled in in the actual URL of the request, to be added to the 'params' property of the request object.

router.get('/member/:username/profile.html', function (req, res, next) {
    getMember(req.params.username, function (error, member) {
        if (error) { return next(error); }
        res.render('member', member);
    });
});

router.get('/art/:username/:compositionNametag.html', function (req, res, next) {
    getMemberComposition(req.params.username, req.params.compositionNametag, function (error, data) {
        if (error) { return next(error); }
        res.render('composition', data);
    });
});

router.get('/update-art/:username/:compositionNametag.html', function (req, res, next) {
    getMemberComposition(req.params.username, req.params.compositionNametag, function (error, data) {
        if (error) { return next(error); }
        res.render('updateComposition', data);
    });
});

router.post('/update-art/:username/:compositionNametag.html', singleFileUpload, function (req, res, next) {
    var docName = compositionIdtag2Docname(req.body.idtag);
    function transformer(oldData, writerFunction) {
        if (!oldData) { return writerFunction(unknown(req.params.username + " " + req.params.compositionNametag)); }
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

router.get('/update-member/:username/profile.html', function (req, res, next) {
    getMember(req.params.username, function (error, data) {
        if (error) { return next(error); }
        res.render('updateMember', data);
    });
});
router.post('/update-member/:username/profile.html', singleFileUpload, function (req, res, next) {
    var docName = memberIdtag2Docname(req.body.idtag);
    function transformer(oldData, writerFunction) {
        if (!oldData) { return writerFunction(unknown(req.params.username)); }
        copyStringProperties(['title', 'description', 'website', 'email', 'username'], req.body, oldData);
        handlePictureUpload(req.file, oldData, writerFunction); // oldData has now been modified
    }
    store.update(docName, undefined, transformer, function (error) {
        if (error) { return next(error); }
        // FIXME: This is a lot of unnecessary round trips and lookups. For now, it's a good test that we got the parsing right.
        res.redirect('/member/' + req.params.username + '/profile.html');
    });
});


router.get('/', function (req, res, next) {
    res.render('index');
});

module.exports = router;
