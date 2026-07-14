#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LABEL="com.dashboard-kindle.agent"
LAUNCHD_DIR="${HOME}/Library/LaunchAgents"
AGENT_DIR="${DASHBOARD_KINDLE_AGENT_DIR:-${HOME}/.dashboard-kindle-agent}"
PLIST_PATH="${LAUNCHD_DIR}/${LABEL}.plist"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
DOMAIN="gui/$(id -u)"

if [ -z "${NODE_BIN}" ]; then
  echo "node was not found. Install Node.js 22 or newer before installing the agent." >&2
  exit 1
fi

mkdir -p "${LAUNCHD_DIR}" "${AGENT_DIR}/logs"
chmod 700 "${AGENT_DIR}" "${AGENT_DIR}/logs"

"${NODE_BIN}" "${ROOT_DIR}/apps/agent/src/main.js" status >/dev/null
"${NODE_BIN}" "${ROOT_DIR}/apps/agent/src/main.js" print-launchd-plist "${ROOT_DIR}" "${NODE_BIN}" "${AGENT_DIR}" > "${PLIST_PATH}"
chmod 600 "${PLIST_PATH}"

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}" "${PLIST_PATH}" >/dev/null 2>&1 || launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
fi

launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}" 2>/dev/null || launchctl load "${PLIST_PATH}"
launchctl enable "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true

echo "Installed ${LABEL}"
echo "Config: ${AGENT_DIR}/config.json"
echo "Logs: ${AGENT_DIR}/logs"
