#!/bin/sh
set -eu

ROOT="${EXTENSION_ROOT:-/mnt/us/extensions/dashboard-kindle}"
STATE_DIR="${ROOT}/state"
CONFIG="${STATE_DIR}/config"
LOG="${STATE_DIR}/client.log"
CURRENT="${STATE_DIR}/current.png"
PREVIOUS="${STATE_DIR}/previous.png"
TMP="${STATE_DIR}/download.tmp"
ETAG_FILE="${STATE_DIR}/etag"
PID_FILE="${STATE_DIR}/poller.pid"

mkdir -p "$STATE_DIR"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG"
}

load_config() {
  if [ -f "$CONFIG" ]; then
    # shellcheck disable=SC1090
    . "$CONFIG"
  fi
  SERVER_URL="${SERVER_URL:-http://127.0.0.1:8787}"
  DEVICE_TOKEN="${DEVICE_TOKEN:-}"
  POLL_SECONDS="${POLL_SECONDS:-300}"
}

configure() {
  mkdir -p "$STATE_DIR"
  {
    echo "SERVER_URL=${SERVER_URL:-http://127.0.0.1:8787}"
    echo "DEVICE_TOKEN=${DEVICE_TOKEN:-paste-device-token-here}"
    echo "POLL_SECONDS=${POLL_SECONDS:-300}"
  } > "$CONFIG"
  log "Wrote configuration template to $CONFIG"
}

display_image() {
  if command -v eips >/dev/null 2>&1; then
    eips -c || true
    eips -g "$CURRENT" || eips 0 0 "Downloaded dashboard image. Use a framebuffer helper on firmware without eips image support."
  else
    log "eips not available; current image retained at $CURRENT"
  fi
}

refresh_once() {
  load_config
  if [ -z "$DEVICE_TOKEN" ] || [ "$DEVICE_TOKEN" = "paste-device-token-here" ]; then
    log "Missing device token"
    exit 2
  fi
  ETAG_HEADER=""
  if [ -f "$ETAG_FILE" ]; then
    ETAG_HEADER="-H If-None-Match: $(cat "$ETAG_FILE")"
  fi
  HTTP_CODE="$(curl -fsS -w '%{http_code}' -o "$TMP" \
    -H "Authorization: Bearer ${DEVICE_TOKEN}" \
    -H "Accept: image/png" \
    $ETAG_HEADER \
    "${SERVER_URL}/api/v1/device/display" || true)"
  if [ "$HTTP_CODE" = "304" ]; then
    rm -f "$TMP"
    log "Display unchanged"
    return 0
  fi
  if [ "$HTTP_CODE" != "200" ]; then
    rm -f "$TMP"
    log "Display fetch failed with HTTP $HTTP_CODE"
    return 1
  fi
  if [ -s "$TMP" ]; then
    [ -f "$CURRENT" ] && cp "$CURRENT" "$PREVIOUS" || true
    mv "$TMP" "$CURRENT"
    sha256sum "$CURRENT" | awk '{print $1}' > "${CURRENT}.sha256" 2>/dev/null || shasum -a 256 "$CURRENT" | awk '{print $1}' > "${CURRENT}.sha256"
    display_image
    log "Display refreshed"
  else
    rm -f "$TMP"
    log "Empty image response"
    return 1
  fi
}

poll_loop() {
  BACKOFF=30
  while true; do
    if refresh_once; then
      BACKOFF=30
      sleep "$POLL_SECONDS"
    else
      sleep "$BACKOFF"
      BACKOFF=$((BACKOFF * 2))
      [ "$BACKOFF" -gt 1800 ] && BACKOFF=1800
    fi
  done
}

start() {
  load_config
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "Poller already running"
    exit 0
  fi
  (poll_loop) &
  echo "$!" > "$PID_FILE"
  log "Started poller"
}

stop() {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  log "Stopped poller"
}

status() {
  load_config
  echo "Server: $SERVER_URL"
  echo "Configured token: $( [ -n "$DEVICE_TOKEN" ] && echo yes || echo no )"
  echo "Current image: $CURRENT"
  echo "Log: $LOG"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  refresh) refresh_once ;;
  status) status ;;
  configure) configure ;;
  restore-power) stop; log "Restore power requested; no persistent power changes are made by this client." ;;
  diagnostics) tar -czf "${STATE_DIR}/diagnostics.tgz" -C "$STATE_DIR" .; echo "${STATE_DIR}/diagnostics.tgz" ;;
  *) echo "Usage: $0 start|stop|refresh|status|configure|restore-power|diagnostics"; exit 2 ;;
esac
