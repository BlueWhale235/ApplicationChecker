#!/bin/sh
set -eu

mkdir -p /data/logs
Xvfb :99 -screen 0 1440x900x24 -ac -nolisten tcp &
x11vnc -display :99 -nopw -forever -shared -localhost -rfbport 5900 >>/data/logs/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 8090 localhost:5900 >>/data/logs/websockify.log 2>&1 &

exec node /usr/local/lib/application-checker-log-wrapper.mjs /data/logs/runner.log \
  node /workspace/apps/runner/dist/runner.js
