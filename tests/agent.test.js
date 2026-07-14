import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentStatus,
  normalizeAgentConfig,
  renderLaunchdPlist
} from "../apps/agent/src/main.js";

test("agent status uses fixtures without raw ActivityWatch titles", () => {
  const status = buildAgentStatus({
    config: normalizeAgentConfig({
      mode: "fixture",
      allowlists: { commands: ["/usr/bin/uptime"], files: ["/tmp/status.json"] }
    }),
    checkedAt: "2026-07-13T12:00:00.000Z"
  });

  assert.equal(status.status, "ok");
  assert.equal(status.mode, "fixture");
  assert.equal(status.allowlists.commandCount, 1);
  assert.equal(status.allowlists.fileCount, 1);
  assert.equal(status.connectors.activitywatch.rawWindowTitlesRedacted, true);
  assert.equal(status.activitywatch.activeMinutes > 0, true);
  assert.equal(JSON.stringify(status).includes("windowTitle"), false);
});

test("agent launchd plist points to daemon mode and private agent dir", () => {
  const plist = renderLaunchdPlist({
    repoRoot: "/Applications/Dashboard Kindle",
    nodeBin: "/opt/homebrew/bin/node",
    agentDir: "/Users/test/.dashboard-kindle-agent"
  });

  assert.match(plist, /com\.dashboard-kindle\.agent/);
  assert.match(plist, /apps\/agent\/src\/main\.js/);
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /DASHBOARD_KINDLE_AGENT_DIR/);
  assert.match(plist, /\/Users\/test\/\.dashboard-kindle-agent\/logs\/agent\.out\.log/);
  assert.equal(plist.includes("&quot;"), false);
});
