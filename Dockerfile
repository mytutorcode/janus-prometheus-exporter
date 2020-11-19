FROM node:lts-slim

ENV NODE_ENV production

RUN mkdir -p /app

COPY package.json /app
COPY node_modules /app/node_modules
COPY src /app

RUN cd /app && npm prune

EXPOSE 8085

CMD /app/server.js
