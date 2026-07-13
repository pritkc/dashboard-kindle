#!/bin/sh
set -eu

ROOT="${EXTENSION_ROOT:-/mnt/us/extensions/dashboard-kindle}"
STATE_DIR="${ROOT}/state"
CONFIG="${STATE_DIR}/config"
LOG="${STATE_DIR}/client.log"
CURRENT="${STATE_DIR}/current.png"
PREVIOUS="${STATE_DIR}/previous.png"
TMP="${STATE_DIR}/download.tmp"
HEADERS="${STATE_DIR}/headers.tmp"
ETAG_FILE="${STATE_DIR}/etag"
POLL_FILE="${STATE_DIR}/next_poll_seconds"
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
  if [ -f "$POLL_FILE" ]; then
    POLL_SECONDS="$(cat "$POLL_FILE")"
  else
    POLL_SECONDS="${POLL_SECONDS:-300}"
  fi
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

header_value() {
  awk -v name="$1" 'BEGIN { IGNORECASE=1 } index($0, name ":") == 1 { sub("^[^:]*:[ \t]*", "", $0); sub("\r$", "", $0); value=$0 } END { print value }' "$HEADERS"
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

display_image() {
  FULL_REFRESH="${1:-false}"
  if command -v eips >/dev/null 2>&1; then
    if [ "$FULL_REFRESH" = "true" ]; then
      eips -c || true
    fi
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
  rm -f "$TMP" "$HEADERS"
  if [ -f "$ETAG_FILE" ]; then
    HTTP_CODE="$(curl -fsS -D "$HEADERS" -w '%{http_code}' -o "$TMP" \
      -H "Authorization: Bearer ${DEVICE_TOKEN}" \
      -H "Accept: image/png" \
      -H "If-None-Match: $(cat "$ETAG_FILE")" \
      "${SERVER_URL}/api/v1/device/display" || true)"
  else
    HTTP_CODE="$(curl -fsS -D "$HEADERS" -w '%{http_code}' -o "$TMP" \
      -H "Authorization: Bearer ${DEVICE_TOKEN}" \
      -H "Accept: image/png" \
      "${SERVER_URL}/api/v1/device/display" || true)"
  fi
  NEXT_POLL="$(header_value "X-Next-Poll-Seconds")"
  if [ -n "$NEXT_POLL" ]; then
    case "$NEXT_POLL" in
      *[!0-9]*) log "Ignoring invalid X-Next-Poll-Seconds: $NEXT_POLL" ;;
      *) echo "$NEXT_POLL" > "$POLL_FILE"; POLL_SECONDS="$NEXT_POLL" ;;
    esac
  fi
  if [ "$HTTP_CODE" = "304" ]; then
    rm -f "$TMP"
    ETAG="$(header_value "ETag")"
    [ -n "$ETAG" ] && echo "$ETAG" > "$ETAG_FILE"
    log "Display unchanged; next poll ${POLL_SECONDS}s"
    return 0
  fi
  if [ "$HTTP_CODE" != "200" ]; then
    rm -f "$TMP"
    log "Display fetch failed with HTTP $HTTP_CODE"
    return 1
  fi
  CONTENT_TYPE="$(header_value "Content-Type")"
  case "$CONTENT_TYPE" in
    image/png*) ;;
    *) rm -f "$TMP"; log "Unexpected content type: $CONTENT_TYPE"; return 1 ;;
  esac
  if [ -s "$TMP" ]; then
    EXPECTED_HASH="$(header_value "X-Image-SHA256")"
    ACTUAL_HASH="$(file_sha256 "$TMP")"
    if [ -n "$EXPECTED_HASH" ] && [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
      rm -f "$TMP"
      log "Image hash mismatch: expected $EXPECTED_HASH got $ACTUAL_HASH"
      return 1
    fi
    ETAG="$(header_value "ETag")"
    [ -f "$CURRENT" ] && cp "$CURRENT" "$PREVIOUS" || true
    mv "$TMP" "$CURRENT"
    echo "$ACTUAL_HASH" > "${CURRENT}.sha256"
    [ -n "$ETAG" ] && echo "$ETAG" > "$ETAG_FILE"
    FULL_REFRESH="$(header_value "X-Full-Refresh")"
    display_image "$FULL_REFRESH"
    log "Display refreshed; full_refresh=${FULL_REFRESH:-false}; next poll ${POLL_SECONDS}s"
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
