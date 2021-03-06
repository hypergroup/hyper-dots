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
  chat: createDB('chat'),
  games: createDB('games'),
  state: createDB('state'),
  users: createDB('users')
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
    }),
    width: game.width,
    height: game.height
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

      var panels = {};
      for (h = 0; h < game.height; h++) {
        for (v = 0; v < game.width; v++) {
          panels[h + '|' + v] = 0;
        }
      }

      var scores = {};
      game.players.forEach(function(id) {
        scores[id.replace(/\./g, '__DOT__')] = 0;
      });

      var state = {
        game: game._id,
        edges: edges,
        panels: panels,
        scores: scores,
        turn: game.players[0]
      };

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

    var panels = [];
    Object.keys(state.panels).forEach(function(place) {
      var owner = state.panels[place];
      var pos = place.split('|');
      var panel = {
        row: parseInt(pos[0]),
        col: parseInt(pos[1])
      };

      if (owner) {
        panel.owner = {
          href: req.base + '/users/' + owner
        };
      }

      panels.push(panel);
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
      panels: panels,
      scores: scores,
      turn: req.base + '/users/' + state.turn
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
    var edges = state.edges;
    if (edges[position] !== 0) return next(new Error('invalid move'));

    edges[position] = req.user.id;

    var scored = false;
    var scores = state.scores;
    var panels = {};
    Object.keys(state.panels).forEach(function(panel) {
      // the panel has been claimed
      if (state.panels[panel]) return panels[panel] = state.panels[panel];

      // verify any new changes
      var pos = panel.split('|');
      var row = parseInt(pos[0], 10);
      var col = parseInt(pos[1], 10);

      // the panel has not been claimed yet
      if (!edges[row + 'h' + col] ||
          !edges[(row + 1) + 'h' + col] ||
          !edges[row + 'v' + col] ||
          !edges[row + 'v' + (col + 1)]) return panels[panel] = 0;

      // the panel was just claimed
      var id = req.user.id;
      panels[panel] = id;
      scores[id.replace(/\./g, '__DOT__')]++;
      scored = true;
    });

    var turn = state.turn;
    if (!scored) {
      var i = game.players.indexOf(req.user.id) + 1;
      turn = game.players[i];
      if (!turn) turn = game.players[0];
    }

    db.state.update({_id: state._id}, {$set: {turn: turn, edges: edges, panels: panels, scores: scores}}, function(err) {
      var url = req.base + '/games/' + req.params.game + '/state';
      notify(url);
      res.redirect(url);
    });
  });
});

api.get('/games/:game/chat', function(req, res, next) {
  db.chat.find({game: req.params.game}).sort({date: 1}).exec(function(err, messages) {
    if (err) return next(err);
    res.json({
      data: messages.map(function(message) {
        return {
          author: {
            href: req.base + '/users/' + message.author
          },
          date: message.date,
          content: message.content
        };
      }),
      message: {
        action: req.base + '/games/' + req.params.game + '/chat',
        method: 'POST',
        input: {
          content: {
            type: 'text',
            required: true
          }
        }
      }
    });
  });
});

api.post('/games/:game/chat', function(req, res, next) {
  var game = res.locals.game;
  var content = req.body.content;
  if (!req.body || !content) return next(new Error('missing content parameter'));

  var message = {
    game: game._id,
    author: req.user.id,
    date: new Date(),
    content: content
  };

  db.chat.insert(message, function(err) {
    var url = req.base + '/games/' + req.params.game + '/chat';
    notify(url);
    res.redirect(url);
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
      res.locals.user.href = res.locals.user.id = id;
      next();
    });
});

api.get('/users/:user', function(req, res, next) {
  var user = res.locals.user;
  res.json({
    name: user.name,
    'first-name': user.first_name,
    'last-name': user.last_name,
    color: stringToColor(user.id)
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

function stringToColor(str) {
  // str to hash
  for (var i = 0, hash = 0; i < str.length; hash = str.charCodeAt(i++) + ((hash << 5) - hash));
  // int/hash to hex
  for (var i = 0, color = "#"; i < 3; color += ("00" + ((hash >> i++ * 8) & 0xFF).toString(16)).slice(-2));

  return color;
}
