#!/usr/bin/env bash
# Runs on every codespace start: hand off to start.sh in the background so the codespace finishes starting.
cd "$(dirname "$0")/.."
setsid nohup bash .devcontainer/start.sh > /tmp/linkos.log 2>&1 < /dev/null &
echo "LINKOS is starting in the background — log: /tmp/linkos.log"
