#!/bin/sh
set -eu

LABEL="com.dashboard-kindle.agent"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}" "${PLIST_PATH}" >/dev/null 2>&1 || launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
fi

if [ -f "${PLIST_PATH}" ]; then
  rm -f "${PLIST_PATH}"
fi

echo "Uninstalled ${LABEL}"
echo "Agent config and logs were left in ${DASHBOARD_KINDLE_AGENT_DIR:-${HOME}/.dashboard-kindle-agent}"
