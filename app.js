/**
 * Module dependencies
 */

var stack = require('simple-stack-ui');
var envs = require('envs');
var api = require('./api');

/**
 * Expose the app
 */

var app = module.exports = stack({
  restricted: false
});

/**
 * Setup app-wide locals
 */

app.env('API_URL', '/api');

app.useBefore('api-proxy', '/api', 'api', api);
app.remove('api-proxy');
