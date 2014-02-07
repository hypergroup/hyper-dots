/**
 * Module dependencies
 */

var app = module.exports = require('simple-ui')('hyper-dots', [
  require('ng-hyper-emitter-ws').name
], require);

/**
 * Initialize aux partials
 */



/**
 * Initialize the directives
 */


/**
 * Start the app
 */

app.start(function($injector) {
  var emitter = $injector.get('hyperEmitterWs');
  emitter({port: 80, host: 'hyper-emitter.herokuapp.com'});
});
