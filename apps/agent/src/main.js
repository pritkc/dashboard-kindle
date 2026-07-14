import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, repoPath } from "../../../packages/domain/src/core.js";

const label = "com.dashboard-kindle.agent";
const defaultIntervalSeconds = 60;

export function defaultAgentDir() {
  return path.join(os.homedir(), ".dashboard-kindle-agent");
}

export function agentPaths(agentDir = process.env.DASHBOARD_KINDLE_AGENT_DIR ?? defaultAgentDir()) {
  return {
    agentDir,
    configPath: path.join(agentDir, "config.json"),
    logDir: path.join(agentDir, "logs"),
    stdoutPath: path.join(agentDir, "logs", "agent.out.log"),
    stderrPath: path.join(agentDir, "logs", "agent.err.log")
  };
}

export function defaultAgentConfig() {
  return {
    mode: "fixture",
    serverUrl: "http://127.0.0.1:8787",
    redactActivityWatchWindowTitles: true,
    allowlists: {
      commands: [],
      files: []
    },
    disabledConnectors: []
  };
}

export function readAgentConfig(configPath = agentPaths().configPath) {
  const config = readJson(configPath, defaultAgentConfig());
  return normalizeAgentConfig(config);
}

export function normalizeAgentConfig(config) {
  const normalized = {
    ...defaultAgentConfig(),
    ...(config && typeof config === "object" && !Array.isArray(config) ? config : {})
  };
  normalized.mode = normalized.mode === "production" ? "production" : "fixture";
  normalized.serverUrl = String(normalized.serverUrl || "http://127.0.0.1:8787");
  normalized.redactActivityWatchWindowTitles = normalized.redactActivityWatchWindowTitles !== false;
  normalized.allowlists = normalized.allowlists && typeof normalized.allowlists === "object" && !Array.isArray(normalized.allowlists)
    ? normalized.allowlists
    : {};
  normalized.allowlists.commands = Array.isArray(normalized.allowlists.commands)
    ? normalized.allowlists.commands.map(String)
    : [];
  normalized.allowlists.files = Array.isArray(normalized.allowlists.files)
    ? normalized.allowlists.files.map(String)
    : [];
  normalized.disabledConnectors = Array.isArray(normalized.disabledConnectors)
    ? normalized.disabledConnectors.map(String)
    : [];
  return normalized;
}

export function ensureAgentConfig(paths = agentPaths()) {
  fs.mkdirSync(paths.agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.configPath)) {
    fs.writeFileSync(paths.configPath, `${JSON.stringify(defaultAgentConfig(), null, 2)}\n`, { mode: 0o600 });
  }
  return readAgentConfig(paths.configPath);
}

export function buildAgentStatus(options = {}) {
  const config = normalizeAgentConfig(options.config ?? defaultAgentConfig());
  const codex = readJson(repoPath("data/fixtures/codexbar.json"), {});
  const activity = readJson(repoPath("data/fixtures/activitywatch.json"), {});
  return {
    status: "ok",
    mode: config.mode,
    serverUrl: config.serverUrl,
    privacy: "ActivityWatch raw window titles are not exported by default.",
    allowlists: {
      commandCount: config.allowlists.commands.length,
      fileCount: config.allowlists.files.length
    },
    connectors: {
      codexbar: {
        mode: "fixture",
        available: !config.disabledConnectors.includes("codexbar.usage")
      },
      activitywatch: {
        mode: "fixture",
        available: !config.disabledConnectors.includes("activitywatch.summary"),
        rawWindowTitlesRedacted: config.redactActivityWatchWindowTitles
      }
    },
    codexbar: codex,
    activitywatch: summarizeActivity(activity),
    checkedAt: options.checkedAt ?? new Date().toISOString()
  };
}

function summarizeActivity(activity) {
  return {
    activeMinutes: activity.activeMinutes,
    codingMinutes: activity.codingMinutes,
    topApplications: activity.topApplications
  };
}

export function renderLaunchdPlist(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? repoPath());
  const nodeBin = options.nodeBin ?? process.execPath;
  const paths = agentPaths(options.agentDir);
  const scriptPath = path.join(repoRoot, "apps/agent/src/main.js");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DASHBOARD_KINDLE_AGENT_DIR</key>
    <string>${xmlEscape(paths.agentDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(paths.stderrPath)}</string>
</dict>
</plist>
`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function runDaemon() {
  const paths = agentPaths();
  const config = ensureAgentConfig(paths);
  const intervalMs = Math.max(5, Number(process.env.DASHBOARD_KINDLE_AGENT_INTERVAL_SECONDS ?? defaultIntervalSeconds)) * 1000;
  const writeStatus = () => {
    process.stdout.write(`${JSON.stringify(buildAgentStatus({ config }), null, 2)}\n`);
  };
  writeStatus();
  const timer = setInterval(writeStatus, intervalMs);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

async function main() {
  const command = process.argv[2] ?? "status";
  if (command === "status") {
    const paths = agentPaths();
    const config = ensureAgentConfig(paths);
    console.log(JSON.stringify(buildAgentStatus({ config }), null, 2));
    return;
  }
  if (command === "daemon") {
    await runDaemon();
    return;
  }
  if (command === "print-launchd-plist") {
    const repoRoot = process.argv[3] ?? repoPath();
    const nodeBin = process.argv[4] ?? process.execPath;
    const agentDir = process.argv[5] ?? defaultAgentDir();
    process.stdout.write(renderLaunchdPlist({ repoRoot, nodeBin, agentDir }));
    return;
  }
  console.error("Usage: node apps/agent/src/main.js [status|daemon|print-launchd-plist <repo-root> <node-bin> <agent-dir>]");
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exit(1);
  });
}
