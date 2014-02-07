/**
 * Module dependencies
 */

var express = require('express');
var superagent = require('superagent');
var envs = require('envs');
var NeDB = require('nedb');

superagent.parse['application/hyper+json'] = superagent.parse['application/json'];

function createDB(name) {
  return new NeDB({
    filename: __dirname + '/' + name + '.db',
    autoload: true
  });
}

var db = {
  games: createDB('games'),
  state: createDB('state')
};

var EMITTER_URL = envs('EMITTER_URL');
function notify(url, fn) {
  fn = fn || function(){};
  if (!EMITTER_URL) return fn();
  superagent
    .post(EMITTER_URL)
    .send({url: url})
    .end(function(err, res) {
      fn(err);
    });
}

/**
 * Expose api
 */

var api = module.exports = express();

api.use(express.json());
api.use(express.urlencoded());

/**
 * Defines
 */

var API_URL = envs('API_URL');

api.use(function(req, res, next) {
  var auth = req.header('authorization');
  if (!auth) return next(new Error('Unauthorized'));

  req.base = req.base || '';
  req.base = req.base + '/api';
  var url = req.base + (req.url === '/' ? '' : req.url);
  var json = res.json;
  res.json = function(obj) {
    obj.href = url;
    json.call(res, obj);
  };

  // TODO cache
  request(API_URL, auth)
    .end(function(err, response) {
      if (err) return next(err);
      if (response.error) return next(response.error);

      // backwards compat hack
      if (!response.body.account) response.body.account = {
        href: response.body.users.href + '/current'
      };

      var users = response.body.users.href;
      request(response.body.account.href, auth)
        .end(function(err, response) {
          if (err) return next(err);
          if (!response.ok) return next(response.error);
          req.user = response.body;
          var href = req.user.href || users + '/' + req.user.id;
          req.user.id = req.user.href = encodeURIComponent(href);
          next();
        });
    });
});

api.get('/', function(req, res) {
  var body = {
    account: {
      href: req.base + '/users/' + req.user.id
    },
    games: {
      href: req.base + '/games'
    }
  };

  res.json(body);
});

api.get('/games', function(req, res, next) {
  db.games.find({}, function(err, games) {
    if (err) return next(err);
    res.json({
      data: games.map(function(game) {
        return {
          href: req.base + '/games/' + game._id
        };
      }),
      open: games.filter(function(game) {
        return game.status === 'waiting';
      }).map(function(game) {
        return {
          href: req.base + '/games/' + game._id
        };
      }),
      create: {
        method: 'POST',
        action: req.base + '/games',
        input: {
          name: {
            type: 'text'
          },
          width: {
            type: 'number',
            value: 9,
            min: 4
          },
          height: {
            type: 'number',
            value: 9,
            min: 4
          }
        }
      }
    });
  });
});

api.post('/games', function(req, res, next) {
  var game = req.body;
  if (!game.name) return next(new Error('request missing "name" parameter'));

  if (typeof game.width === 'string') game.width = parseInt(game.width, 10);
  if (typeof game.height === 'string') game.height = parseInt(game.height, 10);

  var data = {
    name: game.name,
    width: game.width || 9,
    height: game.height || 9,
    owner: req.user.href,
    players: [req.user.href],
    status: 'waiting'
  };

  db.games.insert(data, function(err, doc) {
    if (err) return next(err);
    var url = req.base + '/games/' + doc._id;
    notify(url);
    notify(req.base + '/games');
    res.redirect(303, url);
  });
});

api.param('game', function(req, res, next, id) {
  db.games.findOne({_id: id}, function(err, game) {
    if (err) return next(err);
    if (!game) return res.send(404);
    res.locals.game = game;
    next();
  });
});

api.get('/games/:game', function(req, res, next) {
  var game = res.locals.game;
  var body = {
    name: game.name,
    owner: {
      href: req.base + '/users/' + game.owner
    },
    players: game.players.map(function(player) {
      return {
        href: req.base + '/users/' + player
      };
    })
  };

  if (game.status === 'waiting' && !~game.players.indexOf(req.user.id)) {
    body.join = {
      method: 'POST',
      action: req.base + '/games/' + req.params.game,
      input: {
        _action: {
          type: 'hidden',
          value: 'join'
        }
      }
    };
  }

  if (game.status === 'waiting' && game.owner === req.user.id && game.players.length >= 2) {
    body.start = {
      method: 'POST',
      action: req.base + '/games/' + req.params.game,
      input: {
        _action: {
          type: 'hidden',
          value: 'start'
        }
      }
    };
  }

  if (game.status !== 'waiting') {
    body.state = {
      href: req.base + '/games/' + req.params.game + '/state'
    };
  }

  if (~game.players.indexOf(req.user.id)) {
    body.chat = {
      href: req.base + '/games/' + req.params.game + '/chat'
    };
  }

  res.json(body);
});

api.post('/games/:game', function(req, res, next) {
  var game = res.locals.game;

  if (game.status !== 'waiting') return next(new Error('game has already started'));

  var action = false;
  if (req.body._action === 'join' && !~game.players.indexOf(req.user.id)) {
    game.players.push(req.user.id);
    action = 'join';
  }

  if (req.body._action === 'start' && game.owner === req.user.id) {
    game.status = 'in-progress';
    action = 'start';
  }

  if (!action) return next(new Error('invalid action'));

  var url = req.base + '/games/' + req.params.game;
  db.games.update({_id: req.params.game}, game, function(err) {
    if (action === 'start') {
      var h = 0, v = 0;

      var edges = {};
      for (h = 0; h <= game.height; h++) {
        for (v = 0; v < game.width; v++) {
          edges[h + 'h' + v] = 0;
        }
      }
      for (h = 0; h < game.height; h++) {
        for (v = 0; v <= game.width; v++) {
          edges[h + 'v' + v] = 0;
        }
      }

      var board = {};
      for (h = 0; h < game.height; h++) {
        for (v = 0; v < game.width; v++) {
          board[h + '|' + v] = 0;
        }
      }

      var scores = {};
      game.players.forEach(function(id) {
        scores[id.replace(/\./g, '__DOT__')] = 0;
      });

      var state = {
        game: game._id,
        edges: edges,
        board: board,
        scores: scores,
        turn: game.players[0]
      };

      console.log(state);

      db.state.insert(state, function(err) {
        if (err) return next(err);
        notify(url);
        res.redirect(url);
      });
    } else {
      notify(url);
      res.redirect(url);
    }
  });
});

api.get('/games/:game/state', function(req, res, next) {
  db.state.findOne({game: req.params.game}, function(err, state) {
    if (err) return next(err);
    if (!state) return res.send(404);

    var game = res.locals.game;
    var canPlay = state.turn === req.user.id;

    var edges = [];
    Object.keys(state.edges).forEach(function(place) {
      var owner = state.edges[place];
      var vertical = !!~place.indexOf('v');
      var pos = vertical
        ? place.split('v')
        : place.split('h');

      var edge = {
        occupied: !!owner,
        row: parseInt(pos[0]),
        col: parseInt(pos[1]),
        type: vertical ? 'v' : 'h'
      };

      if (owner) {
        edge.owner = {
          href: req.base + '/users/' + owner
        };
      }

      if (!owner && canPlay) {
        edge.occupy = {
          method: 'POST',
          action: req.base + '/games/' + req.params.game + '/state',
          input: {
            position: {
              type: 'hidden',
              value: place
            }
          }
        }
      }

      edges.push(edge);
    });

    var board = [];
    Object.keys(state.board).forEach(function(place) {
      var owner = state.edges[place];
      var pos = place.split('|');
      var b = {
        occupied: !!owner,
        row: parseInt(pos[0]),
        col: parseInt(pos[1])
      };

      if (owner) {
        b.owner = {
          href: req.base + '/users/' + owner
        };
      }

      board.push(b);
    });

    var scores = Object.keys(state.scores).map(function(player) {
      var score = state.scores[player];
      return {
        player: {
          href: req.base + '/users/' + player.replace(/__DOT__/g, '.')
        },
        score: score
      };
    });

    res.json({
      edges: edges,
      board: board,
      scores: scores,
      turn: state.turn
    });
  });
});

api.post('/games/:game/state', function(req, res, next) {
  var game = res.locals.game;
  var position = req.body.position
  if (!req.body || !position) return next(new Error('missing position parameter'));
  db.state.findOne({game: req.params.game}, function(err, state) {
    if (err) return next(err);
    if (!state) return res.send(404);
    if (state.turn !== req.user.id) return next(new Error('tried to play out of turn... nice try'));
    if (state.edges[position] !== 0) return next(new Error('invalid move'));

    state.edges[position] = req.user.id;

    // TODO fill in squares
    // TODO compute scores

    var i = game.players.indexOf(req.user.id) + 1;
    var turn = game.players[i];
    if (!turn) turn = game.players[0];

    db.state.update({_id: state._id}, {$set: {turn: turn, edges: state.edges}}, function(err) {
      var url = req.base + '/games/' + req.params.game + '/state';
      notify(url);
      res.redirect(url);
    });
  });
});

api.param('user', function(req, res, next, id) {
  if (id === req.user.id) {
    res.locals.user = req.user;
    next();
  }

  request(decodeURIComponent(id), req.header('authorization'))
    .end(function(err, response) {
      if (err) return next(err);
      if (!response.ok) return next(response.error);
      res.locals.user = response.body;
      next();
    });
});

api.get('/users/:user', function(req, res, next) {
  var user = res.locals.user;
  res.json({
    name: user.name,
    'first-name': user.first_name,
    'last-name': user.last_name
  });
});

api.use(function(err, req, res, next) {
  console.error(err.stack || err.message || err);
  res.json({
    error: {
      message: err.message,
      stack: err.stack
    }
  });
});

function request(href, token) {
  return superagent
    .get(href)
    .set({accept: 'application/hyper+json', authorization: token})
    .buffer(true);
}
