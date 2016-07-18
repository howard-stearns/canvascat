"use strict";
/*jslint node: true, nomen: true*/
/*
  canvascat uses javascript on both client and server, to simplify maintenance and development.

  The server uses:
  I. an implementation of javascript called node: https://nodejs.org
  II. software packages for node that are distributed through npm: https://www.npmjs.com/
  III. a server package and framework called express:http://expressjs.com/
  Note that these are all aka their domain name in the literature: nodejs, npmjs, expressjs.

  Except as noted, and additions to package.json, this is a generated by express generator
  (http://expressjs.com/en/starter/generator.html). This provides some standard glue code
  that any expressjs programmer will recognize.

  Following the conventions of npm and express, you can run the server from the command line with:
      npm start
  and then visit the site running on that machine by vising http://localhost:3000 in your browser.

  The general arrangement is:
  1. The file sets up some general "glue" in javascript. (There's a little bit more glue in bin/www.)
  2. The routes directory has code that sets up expressjs "routes" in javascript - handlers for HTTP GET
     or POST requests. A route handler does some computation (sometimes adding results to the request or
     response objects) and then either calls the next applicable handler with or without an error, or
     provides the response. (A response or error terminates the chain of handlers.) Each route can be
     limited to particular URL path (specified as an optional pattern string) and limited to a particular
     request type (.get() or .post(), or for all when setting the route with .use()).
  3. The handlers ultimate ask express to "render" data using a template in jade (a template language).
     These are defined in the views directory.
 4. Other files are just served directly from the public directory (defined
*/
process.title = 'canvascat';          // added so we can kill the server with shell (pkill canvascat)
var doesNotExist = require('ki1r0y.fs-store').doesNotExist;

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
// no need: app.use(bodyParser.json());
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

// error handler (slightly modified from that produced by expressjs generator
app.use(function(err, req, res, next) {
    if (doesNotExist(err)) { err.status = 404; } // Internal not founds are 404s
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: (app.get('env') === 'development') ? err : {} // No stack trace in production.
    });
});


module.exports = app;
