#!/bin/zsh
set -euo pipefail

WORKDIR="/Users/bradacova/Documents/Github velocity"
NODE_BIN="/opt/homebrew/bin/node"
LOGDIR="$WORKDIR/logs"
LOGFILE="$LOGDIR/weekday-sync.log"
EXPORT_SOURCE="$WORKDIR/dashboard/data/sharepoint-list.json"
EXPORT_TARGET="/Users/bradacova/Library/CloudStorage/OneDrive-SharedLibraries-Shoptet,a.s/Product Department - Velocity dashboard/velocity-sprints.json"

mkdir -p "$LOGDIR"

{
  echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S %Z')] Starting weekday dashboard sync"
  cd "$WORKDIR"
  "$NODE_BIN" scripts/sync-dashboard-from-github.js --mode sync --project ""
  "$NODE_BIN" scripts/export-sharepoint-list.js "$WORKDIR/dashboard/data/sprints.json" "$EXPORT_SOURCE"
  /bin/cp "$EXPORT_SOURCE" "$EXPORT_TARGET"
  echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S %Z')] Weekday dashboard sync finished"
} >>"$LOGFILE" 2>&1
