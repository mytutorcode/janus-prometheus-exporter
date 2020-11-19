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

const sessionGauge = new client.Gauge({
  name: "sessions_active",
  help: "Tracks the number of active sessions on the server",
});
sessionGauge.set(0);
const roomGauge = new client.Gauge({
  name: "rooms_active",
  help: "Tracks the number of active rooms (read: lessons)",
});
roomGauge.set(0);
const usersGauge = new client.Gauge({
  name: "users_active",
  help: "Tracks the number of active users (read: lessons) in a room",
});
usersGauge.set(0);
const sessionStat = new client.Counter({
  name: "sessions_total",
  help: "Tracks the number of total sessions this server has processed",
});
const userSessionDurationHist = new client.Histogram({
  name: "users_session_duration",
  help:
    "Tracks session duration for a user in minutes (Note: this is not a unique user i.e. by name the id may change if they CTRL+R)",
  buckets: [10, 20, 30, 40, 50],
});

let roomCache = {};
let userCache = {};

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
  // console.log(JSON.stringify(json, null, 2));
  if (json.type === 1) {
    // Session event
    var sessionId = json["session_id"];
    var event = json["event"]["name"];
    var when = new Date(json["timestamp"] / 1000);
    if (event === "created") {
      sessionGauge.inc();
      sessionStat.inc();
    } else if (event === "destroyed") {
      sessionGauge.dec();
    }
  } else if (json.type === 2) {
    // Handle event
    var sessionId = json["session_id"];
    var handleId = json["handle_id"];
    var event = json["event"]["name"];
    var plugin = json["event"]["plugin"];
    var when = new Date(json["timestamp"] / 1000);
    // TODO: gauge up
  } else if (json.type === 8) {
    // JSEP event
    var sessionId = json["session_id"];
    var handleId = json["handle_id"];
    var remote = json["event"]["owner"] === "remote";
    var offer = json["event"]["jsep"]["type"] === "offer";
    var sdp = json["event"]["jsep"]["sdp"];
    var when = new Date(json["timestamp"] / 1000);
    // TODO: ???
  } else if (json.type === 16) {
    // WebRTC event (can result in writes to different tables)
    var sessionId = json["session_id"];
    var handleId = json["handle_id"];
    var streamId = json["event"]["stream_id"];
    var componentId = json["event"]["component_id"];
    var when = new Date(json["timestamp"] / 1000);
    if (json["event"]["ice"]) {
      // ICE state event
      var state = json["event"]["ice"];
      // Write to DB
      logger.info(state);
      // TODO:
    } else if (json["event"]["selected-pair"]) {
      // ICE selected-pair event
      var pair = json["event"]["selected-pair"];
      logger.info(pair);
      // TODO:
    } else if (json["event"]["dtls"]) {
      // DTLS state event
      var state = json["event"]["dtls"];
      logger.info(state);
      // TODO:
    } else if (json["event"]["connection"]) {
      // Connection (up/down) event
      var state = json["event"]["connection"];
      logger.info(state);
      // TODO:
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
      // TODO:
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
    var event = json["event"]["data"];
    var when = new Date(json["timestamp"] / 1000);
    if (plugin === "janus.plugin.videoroom") {
      switch (event.event) {
        case "joined":
          usersGauge.inc();
          userCache[event.id] = {
            start: Date.now(),
            name: event.display,
          };
          if (!Object.keys(roomCache).includes(String(event.room))) {
            roomGauge.inc();
            roomCache[event.room] = 1;
          } else {
            roomCache[event.room] = ++roomCache[event.room];
          }
          break;
        case "leaving":
          usersGauge.dec();
          let room = roomCache[event.room];
          const userSession = userCache[event.id];
          if (userSession) {
            const durationMillis = Date.now() - userSession.start;
            userSessionDurationHist.observe(Math.round(durationMillis / 60000));
            delete userCache[event.id];
          }
          if (room >= 1) {
            room--;
            roomCache[event.room] = room;
            if (room === 0) {
              delete roomCache[event.room];
              roomGauge.dec();
            }
          } else {
            delete roomCache[event.room];
            roomGauge.dec();
          }
      }
    }
    // TODO: ???
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
