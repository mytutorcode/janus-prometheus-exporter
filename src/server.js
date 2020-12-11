#!/usr/bin/env node

var util = require("util");
var format = util.format;
var errorhandler = require("errorhandler");
var _ = require("underscore");
var express = require("express");
var http = require("http");
var morgan = require("morgan");
var winston = require("winston");
var bodyParser = require("body-parser");
var config = require("./config");

const client = require("prom-client");
const collectDefaultMetrics = client.collectDefaultMetrics;
const prefix = "janus_";
const labels = {
  // low cardinality
  NAMESPACE: process.env.NAMESPACE,
  ENVIRONMENT: process.env.ENVIRONMENT,
  NAME: process.env.NAME,
  SVC: "janus",
};
collectDefaultMetrics({ prefix, labels });

const roomGauge = new client.Gauge({
  name: "rooms_active",
  help: "Tracks the number of active rooms (read: lessons)",
});
roomGauge.set(0);
const roomTotal = new client.Gauge({
  name: "rooms_total",
  help: "Tracks the number of total rooms since server start",
});
const usersGauge = new client.Gauge({
  name: "users_active",
  help: "Tracks the number of active users (read: lessons) in a room",
});
usersGauge.set(0);
const usersCounter = new client.Counter({
  name: "users_total",
  help: "Tracks the number of total users since server start",
});
const userSessionDurationHist = new client.Histogram({
  name: "users_session_duration",
  help: "Tracks session duration for a user in minutes",
  buckets: client.linearBuckets(0, 10, 7)
});
const peerConnectionsCounter = new client.Counter({
  name: "server_peerconnections_total",
  help: "Tracks the total peer connections since server restart",
});
const iceConnectionsCounter = new client.Counter({
  name: "server_ice_connections_total",
  help: "Tracks the total ICE connections since server restart",
});
const iceDisconnectsCounter = new client.Counter({
  name: "server_ice_disconnects_total",
  help: "Tracks the total ICE disconnects since server restart",
});
const publishersGauge = new client.Gauge({
  name: "server_publishers_active",
  help: "Tracks the number of active publishers",
})
const subscribingTotal = new client.Counter({
  name: "server_subscribing_total",
  help: "Tracks the total number of attempts to subscribe to a remote feed (before answer)",
})
const subscribersGauge = new client.Gauge({
  name: "server_subscribers_active",
  help: "Tracks the number of active publishers",
})
const subscribersTotal = new client.Counter({
  name: "server_subscribers_total",
  help: "Tracks the number of completed subscriptions",
})
const mediaCounter = new client.Counter({
  name: "server_media_total",
  help: "Tracks the total number of media streams being received by Janus",
  labelNames: ["type"]
})
const webSocketActiveConnections = new client.Gauge({
  name: "server_websocket_active",
  help: "Tracks the active websocket connections to the server"
})
const webSocketConnectionsCounter = new client.Counter({
  name: "server_websocket_connections_total",
  help: "Tracks the total of websocket connections to the server"
})
const webSocketDisconnectsCounter = new client.Counter({
  name: "server_websocket_disconnects_total",
  help: "Tracks the total of websocket disconnects from the server"
})
let rooms = new Map();
let users = new Map();
let publishers = new Map();

var app = express();

if (process.env.NODE_ENV !== "production") {
  app.use(
    errorhandler({
      dumpExceptions: true,
      showStack: true,
    })
  );
  //app.use(morgan('dev'));
}

const logger = winston.createLogger();

const cliLogFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.cli()
);

if (config.logDir) {
  logger.add(
    new winston.transports.File({
      filename: config.logDir + "/server.log",
      level: "info",
    })
  );
} else {
  logger.add(
    new winston.transports.Console({
      level: "debug",
      format: cliLogFormat,
    })
  );
}

app.use(bodyParser.json());

app.get("/", function (req, res) {
  res.send(
    "Janus events server, this page does nothing, Janus must POST to /event"
  );
});

app.get("/monitor/", function (req, res) {
  logger.debug("Got monitor request");
  res.send("up");
});

app.get("/metrics", (req, res) => {
  res.send(client.register.metrics());
});

app.post("/event", function (req, res) {
  try {
    var events = req.body;
    if (!_.isArray(events)) {
      events = [events];
    }
    for (var key in events) {
      var event = events[key];

      eventHandler(event);
    }
    var status = 200;
    res.status(status).end(http.STATUS_CODES[status]);
  } catch (e) {
    logger.error(e);
    res.status(500).send(String(e));
  }
});

logger.info(format("Server listening on port %d", config.port));
http.createServer(app).listen(config.port);

const eventHandler = (json) => {
  if (Array.isArray(json)) {
    // We got an array: it means we have multiple events, iterate on all of them
    for (var i = 0; i < json.length; i++) {
      eventHandler(json[i]);
    }
    return;
  }
  if (json.type === 1) {
    // Session event
    var sessionId = json["session_id"];
    var event = json["event"]["name"];
    var when = new Date(json["timestamp"] / 1000);
  } else if (json.type === 2) {
    // Handle event
    var sessionId = json["session_id"];
    var handleId = json["handle_id"];
    var event = json["event"]["name"];
    var plugin = json["event"]["plugin"];
    var when = new Date(json["timestamp"] / 1000);
  } else if (json.type === 8) {
    // JSEP event
    var sessionId = json["session_id"];
    var handleId = json["handle_id"];
    var remote = json["event"]["owner"] === "remote";
    var offer = json["event"]["jsep"]["type"] === "offer";
    var sdp = json["event"]["jsep"]["sdp"];
    var when = new Date(json["timestamp"] / 1000);
  } else if (json.type === 16) {
    // WebRTC event (can result in writes to different tables)
    var sessionId = json["session_id"];
    var handleId = json["handle_id"];
    var streamId = json["event"]["stream_id"];
    var componentId = json["event"]["component_id"];
    var when = new Date(json["timestamp"] / 1000);
    if (json["event"]["ice"]) {
      var state = json["event"]["ice"];
      if (state === "connected") {
        iceConnectionsCounter.inc();
      }
      else if (state === "disconnected") {
        iceDisconnectsCounter.inc();
      }
    }
    else if (json["event"]["connection"]) {
      var state = json["event"]["connection"];
      if (state === "webrtcup") {
        peerConnectionsCounter.inc()
      }
      else if (state === "hangup") {
        // TODO
      }
    } else {
      console.error("Unsupported WebRTC event?");
    }
  } else if (json.type === 32) {
    // Media event (can result in writes to different tables)
    var sessionId = json["session_id"];
    var handleId = json["handle_id"];
    var medium = json["event"]["media"];
    var when = new Date(json["timestamp"] / 1000);
    if (
      json["event"]["receiving"] !== null &&
      json["event"]["receiving"] !== undefined
    ) {
      // Media receiving state event
      var receiving = json["event"]["receiving"] === true;
      const pub = publishers.get(handleId)
      if (receiving) {
        if (medium === "audio" && !pub.audio) {
          publishers.set(handleId, Object.assign(publishers.get(handleId) || {}, {audio: true}))
          mediaCounter.inc({ type: "audio" }, 1);
        }
        else if (medium === "video" && !pub.video) {
          publishers.set(handleId, Object.assign(publishers.get(handleId) || {}, {video: true}))
            mediaCounter.inc({ type: "video" }, 1);
        }
      };
    } else if (
      json["event"]["base"] !== null &&
      json["event"]["base"] !== undefined
    ) {
      // Statistics event
      var base = json["event"]["base"];
      var lsr = json["event"]["lsr"];
      var lostlocal = json["event"]["lost"];
      var lostremote = json["event"]["lost-by-remote"];
      var jitterlocal = json["event"]["jitter-local"];
      var jitterremote = json["event"]["jitter-remote"];
      var packetssent = json["event"]["packets-sent"];
      var packetsrecv = json["event"]["packets-received"];
      var bytessent = json["event"]["bytes-sent"];
      var bytesrecv = json["event"]["bytes-received"];
      var nackssent = json["event"]["nacks-sent"];
      var nacksrecv = json["event"]["nacks-received"];
      // TODO:
    } else {
      console.error("Unsupported media event?");
    }
  } else if (json.type === 64 || json.type === 128) {
    // Plugin or transport event
    var sessionId = json["session_id"];
    var handleId = json["handle_id"];
    var plugin = json["event"]["plugin"];
    var transport = json["event"]["transport"];
    var event = json["event"]["data"];
    var when = new Date(json["timestamp"] / 1000);
    if (plugin === "janus.plugin.videoroom") {
      const room = rooms.get(event.room);
      switch (event.event) {
        case "joined":
          usersGauge.inc();
          usersCounter.inc();
          users.set(handleId, {
            start: Date.now(),
            name: event.display,
            feed: event.id,
            room: event.room
          });
          if (!room) {
            rooms.set(event.room, {
              users: 1
            })
            roomGauge.inc()
            roomTotal.inc()
          }
          else {
            rooms.set(event.room, Object.assign(room, {users: (room.users + 1)}))
          }
          break;
        case "leaving":
          for (let e of users.entries()) {
            const [id, user] = e
            if (user.feed === event.id) {
              const durationMillis = Date.now() - user.start;
              let durationMinutes = Math.round(durationMillis / 60000);

              if (durationMinutes > 60) {
                durationMinutes = 60
              }

              userSessionDurationHist.observe(durationMinutes);
              usersGauge.dec();
              users.delete(id)
            }
          }
          for (let e of publishers.entries()) {
            const [id, publisher] = e;
            if (publisher.feed === event.id) {
              publishers.delete(id)
            }
          }
          if (room) {
            if (room.users === 1) {
              roomGauge.dec()
              rooms.delete(event.room)
            }
            else {
              rooms.set(event.room, Object.assign(room, {users: room.users - 1}))
            }
          }
          break;
        case "subscribing":
          subscribingTotal.inc()
          break;
        case "subscribed":
          subscribersTotal.inc()
          for (let e of publishers.entries()) {
            const [id, publisher] = e;
            if (publisher.feed === event.feed) {
              if (!publisher.subscribers.get(handleId)) {
                subscribersGauge.inc();
                publisher.subscribers.set(handleId, {
                  start: Date.now(),
                  feed: event.feed,
                  session: sessionId
                })
              }
            }
          }
          break;
        case "published":
          publishers.set(handleId, {
            start: Date.now(),
            feed: event.id,
            subscribers: new Map(),
            session: sessionId
          })
          publishersGauge.inc()
          break;
        case "unpublished":
          let session;
          for (let e of publishers.entries()) {
            const [id, publisher] = e;

            if (publisher.feed === event.id) {
              session = publisher.session;
            }
          }

          for (let e of publishers.entries()) {
            const [id, publisher] = e;
            if (publisher.feed === event.id) {
              publishersGauge.dec();

              if (publisher.subscribers.size > 0) {
                subscribersGauge.dec(publisher.subscribers.size)
              }

              publishers.delete(id);
            }
            else {
              for (let f of publisher.subscribers.entries()) {
                const [id, subscriber] = f;

                if (subscriber.session === session) {
                  subscribersGauge.dec()
                  publisher.subscribers.delete(id)
                }
              }
            }
          }
      }
    }
    else if (transport === "janus.transport.websockets") {
      switch (event.event) {
        case "connected":
          webSocketConnectionsCounter.inc()
          webSocketActiveConnections.inc();
          break;
        case "disconnected":
          webSocketDisconnectsCounter.inc()
          webSocketActiveConnections.dec();
      }
    }
  } else if (json.type === 256) {
    // Core event
    var name = "status";
    var event = json["event"][name];
    var signum = json["event"]["signum"];
    if (signum) event += " (" + signum + ")";
    var when = new Date(json["timestamp"] / 1000);
    // TODO: ???
  } else {
    console.warn("Unsupported event type " + json.type);
  }
};
