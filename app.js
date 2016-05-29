"use strict";
/*jslint node: true, nomen: true*/
/*
  canvascat uses javascript on both client and server, to simplify maintenance and development.

  The server uses:
   - an implementation of javascript called node: https://nodejs.org
   - software packages for node that are distributed through npm: https://www.npmjs.com/
   - a server package and framework called express:http://expressjs.com/
   Note that these are all aka their domain name in the literature: nodejs, npmjs, expressjs.

  Except as noted, and additions to package.json, this is a generated by express generator
  (http://expressjs.com/en/starter/generator.html). This provides some standard glue code
  that any expressjs programmer will recognize.

  Following the conventions of npm and express, you can run the server from the command line with:
      npm start
  and then visit the site running on that machine by vising http://localhost:3000 in your browser.
*/

var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');

var routes = require('./routes/index');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', routes); // Mount our routes here.

// catch 404 and forward to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {}
    });
});


module.exports = app;
