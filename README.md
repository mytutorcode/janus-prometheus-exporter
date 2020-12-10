# Janus Prometheus Exporter

Scrape metrics from Janus server and export to Prometheus.

## Installation

```
npm i -g nodemon
npm i
npm run start
```

## Configuration

1. Enable `broadcast` under `[events]` in `janus.jcfg`
2. Configure event handler plugin `janus.eventhandler.sampleevh.jcfg`

```
[general]
enabled = ye
events = all
grouping = yes
backend = http://localhost:8085/event
```

## Implemented metrics

### WebRTC

 * Number of active websockets
 * Total websocket connections
 * Total websocket disconnects
 * Total peer connections
 * Total ICE connections
 * Total ICE disconnects
 * Number of media streams [audio,video]

### VideoRoom
 * Number of active rooms
 * Total rooms
 * Number of active users
 * Total users
 * Average user session duration
 * Number of publishers
 * Number of subscribers
 * Total subscribing (after offer/before answer)
 * Total subscription errors

## Development & Testing

1. `docker-compose up`
2. Edit your `/etc/hosts` file to resolve `janus.local` to `127.0.0.1`
3. Open chrome using binary e.g. `/opt/google/chrome/google-chrome --ignore-certificate-errors --ignore-urlfetcher-cert-requests` so that the self signed CA
 is trusted
4. Visit `janus.local:8080` and start a video room demo
5. Scrape metrics using curl `curl http://janus.local:8085/metrics`
