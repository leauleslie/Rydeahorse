#!/bin/bash
#
# Double-click this file in Finder to run the app.
#
# It starts the two pieces the app needs — the data service and the web page — waits until
# both are genuinely answering, and opens your browser. Closing the Terminal window it opens,
# or pressing Control-C in it, stops both cleanly.
#
# Written to be run by a person, not a build system: every failure below prints what went
# wrong in plain language and what to do about it, rather than a stack trace.

set -u

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"

API_PORT=3001
WEB_PORT=5173
WEB_URL="http://localhost:${WEB_PORT}"
LOG_DIR="$ROOT/.run"
mkdir -p "$LOG_DIR"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
dim()  { printf "\033[2m%s\033[0m\n" "$1"; }
fail() {
  printf "\n\033[31m%s\033[0m\n" "Couldn't start the app."
  printf "%s\n\n" "$1"
  printf "%s\n" "This window will stay open so you can read the message."
  printf "%s\n" "Press Return to close it."
  read -r _
  exit 1
}

echo
bold "Rydeahorse"
dim  "Starting the app. This usually takes about ten seconds."
echo

# --- checks that fail clearly, before anything is started ------------------------------------

command -v node >/dev/null 2>&1 || fail \
"Node isn't installed on this Mac, and the app can't run without it.
Install it from https://nodejs.org (choose the 'LTS' version), then double-click this file again."

[ -f "$ROOT/.env.local" ] || fail \
"The file that holds the database connection details is missing.
It should be at:  $ROOT/.env.local
It is deliberately never shared or committed, so a fresh copy of this project won't have one."

DB_URL="$(sed -n 's/^TEST_DATABASE_URL="\(.*\)"$/\1/p' "$ROOT/.env.local")"
[ -n "$DB_URL" ] || fail \
"Couldn't find TEST_DATABASE_URL inside .env.local.
That line is what tells the app which database to use."

[ -d "$ROOT/app/node_modules" ] || fail \
"The web page's supporting files haven't been downloaded yet.
Open Terminal and run:  cd '$ROOT/app' && npm install"

[ -d "$ROOT/server/node_modules" ] || fail \
"The data service's supporting files haven't been downloaded yet.
Open Terminal and run:  cd '$ROOT/server' && npm install"

# --- stop anything this script left running last time ----------------------------------------
#
# Reusing a half-dead server from a previous run is the single most confusing failure here: the
# page loads but shows stale data, or loads nothing at all. Always start from a clean slate.

for port in $API_PORT $WEB_PORT; do
  pids="$(lsof -nP -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    dim "Stopping something already using port $port…"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    pids="$(lsof -nP -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)"
    # shellcheck disable=SC2086
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
done

# --- start both pieces -----------------------------------------------------------------------

cleanup() {
  echo
  dim "Stopping the app…"
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null
  wait 2>/dev/null
  dim "Stopped."
}
trap cleanup EXIT INT TERM

APP_DATABASE_URL="$DB_URL" PORT="$API_PORT" \
  node "$ROOT/server/index.js" > "$LOG_DIR/api.log" 2>&1 &
API_PID=$!

# --root matters: without it Vite serves whatever folder this script was run from, which has no
# web page in it, and every request comes back 404 while both processes look perfectly healthy.
node "$ROOT/app/node_modules/vite/bin/vite.js" "$ROOT/app" \
  --port "$WEB_PORT" --strictPort > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!

# --- wait until both are genuinely answering -------------------------------------------------
#
# Not "has the process started" — that is true immediately and means nothing. The database sleeps
# when unused and takes a few seconds to wake, so the first real request is the only honest test.

printf "  Waking the database and starting the app"
ready=""
for _ in $(seq 1 60); do
  printf "."
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo
    fail "The data service stopped unexpectedly. What it reported:

$(tail -n 20 "$LOG_DIR/api.log")"
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo
    fail "The web page server stopped unexpectedly. What it reported:

$(tail -n 20 "$LOG_DIR/web.log")"
  fi
  if curl -sf -o /dev/null -m 5 "http://localhost:${API_PORT}/api/bootstrap?date=2026-09-15" \
     && curl -sf -o /dev/null -m 5 "$WEB_URL"; then
    ready="yes"
    break
  fi
  sleep 1
done
echo

[ -n "$ready" ] || fail \
"The app started but never began answering, after a minute of waiting.
The two logs below often say why:
  $LOG_DIR/api.log
  $LOG_DIR/web.log"

# --- hand it over ----------------------------------------------------------------------------

echo
bold "The app is running."
echo "  $WEB_URL"
echo
dim "Opening it in your browser now."
dim "Leave this window open — closing it stops the app."
dim "To stop it deliberately: press Control-C here, or just close this window."
echo

open "$WEB_URL" 2>/dev/null || true

# Park here so the trap above fires when the window closes or Control-C is pressed.
wait
