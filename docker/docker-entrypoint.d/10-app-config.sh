#!/bin/sh
# Rewrites config.js on every container start so APP_HEADING, APP_TAB_TITLE,
# APP_HISTORY_LIMIT, APP_RUNNERS_REFRESH_SECONDS and the three APP_*_PAGE_SIZE
# values can be changed from the Helm values without rebuilding the image.
set -e

CONFIG_FILE=${CONFIG_FILE:-/usr/share/nginx/html/config.js}

escape() {
  printf '%s' "$1" | tr -d '\r\n' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Leading zeros are stripped: written unquoted into config.js, "020" would
# otherwise be a legacy octal literal and silently mean 16.
number() {
  case "$1" in
    "" | *[!0-9]*) printf '%s' "$2" ; return ;;
  esac
  stripped=$(printf '%s' "$1" | sed 's/^0*//')
  if [ -n "$stripped" ] && [ "$stripped" -gt 0 ] 2>/dev/null; then
    printf '%s' "$stripped"
  else
    printf '%s' "$2"
  fi
}

HEADING=$(escape "${APP_HEADING:-GitHub Runner Monitor}")
TAB_TITLE=$(escape "${APP_TAB_TITLE:-Runner Monitor}")
HISTORY_LIMIT=$(number "${APP_HISTORY_LIMIT}" 200)
HISTORY_PAGE_SIZE=$(number "${APP_HISTORY_PAGE_SIZE}" 20)
QUEUE_PAGE_SIZE=$(number "${APP_QUEUE_PAGE_SIZE}" 10)
RUNNING_PAGE_SIZE=$(number "${APP_RUNNING_PAGE_SIZE}" 10)
QUEUE_MAX_ITEMS=$(number "${APP_QUEUE_MAX_ITEMS}" 200)
RUNNERS_REFRESH_SECONDS=$(number "${APP_RUNNERS_REFRESH_SECONDS}" 30)

cat > "$CONFIG_FILE" <<CONFIG
window.__APP_CONFIG__ = {
  heading: "$HEADING",
  tabTitle: "$TAB_TITLE",
  historyLimit: $HISTORY_LIMIT,
  historyPageSize: $HISTORY_PAGE_SIZE,
  queuePageSize: $QUEUE_PAGE_SIZE,
  queueMaxItems: $QUEUE_MAX_ITEMS,
  runningPageSize: $RUNNING_PAGE_SIZE,
  runnersRefreshSeconds: $RUNNERS_REFRESH_SECONDS
};
CONFIG
