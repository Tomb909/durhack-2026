#!/usr/bin/env bash
# Build the world page and (re)start the server.
#
#   ./run.sh                 build web, stop anything on :8000, start the server
#   ./run.sh --dev           also start the hot-reload page on :5173
#   ./run.sh --no-build      skip the web build
#   ./run.sh -- --no-read    anything after -- goes to `uv run deck`
#                            (e.g. --source synth, --record recordings/run1)
set -euo pipefail
cd "$(dirname "$0")"

DEV=0
BUILD=1
DECK_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dev) DEV=1 ;;
    --no-build) BUILD=0 ;;
    --) shift; DECK_ARGS=("$@"); break ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) DECK_ARGS+=("$1") ;;
  esac
  shift
done

# Node is installed but not always on PATH (e.g. Git Bash on Windows).
if ! command -v npm >/dev/null 2>&1 && [ -d "/c/Program Files/nodejs" ]; then
  export PATH="/c/Program Files/nodejs:$PATH"
fi
command -v npm >/dev/null 2>&1 || { echo "npm not found: install Node.js" >&2; exit 1; }
command -v uv  >/dev/null 2>&1 || { echo "uv not found: install uv" >&2; exit 1; }

# Stop whatever is listening on a port, so a re-run reloads cleanly.
free_port() {
  local port=$1 pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
  elif command -v netstat >/dev/null 2>&1; then
    pids=$(netstat -ano 2>/dev/null | awk -v p=":$port" '$2 ~ p"$" && $4 == "LISTENING" {print $5}' | sort -u)
    for pid in $pids; do taskkill //PID "$pid" //F >/dev/null 2>&1 || true; done
  fi
  [ -n "$pids" ] && echo "Stopped old process on :$port" || true
}

[ -d web/node_modules ] || { echo "Installing web dependencies..."; npm --prefix web install; }
uv sync

if [ "$BUILD" = 1 ]; then
  echo "Building world page..."
  npm --prefix web run build
fi

free_port 8000

if [ "$DEV" = 1 ]; then
  free_port 5173
  npm --prefix web run dev &
  VITE_PID=$!
  trap 'kill $VITE_PID 2>/dev/null || true' EXIT INT TERM
  echo "Hot-reload page: http://localhost:5173"
fi

echo "World page: http://localhost:8000  (press G for the setup guide)"
uv run deck ${DECK_ARGS[@]+"${DECK_ARGS[@]}"}
