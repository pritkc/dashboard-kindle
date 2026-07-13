import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const SCHEMA_VERSION = 1;

export function nowIso() {
  return new Date().toISOString();
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hashPayload(value) {
  return sha256(stableStringify(value));
}

export function selectPath(payload, expression) {
  if (!expression || expression === "$") return payload;
  return expression
    .replace(/^\$\./, "")
    .split(".")
    .filter(Boolean)
    .reduce((current, segment) => {
      if (current === undefined || current === null) return undefined;
      if (/^\d+$/.test(segment)) return current[Number(segment)];
      return current[segment];
    }, payload);
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = /token|secret|password|key|cookie|authorization/i.test(key) ? "[REDACTED]" : redact(item);
  }
  return redacted;
}

export function isPrivateNetworkUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::1") return true;
  if (/^127\./.test(host) || /^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  return false;
}

export function computeNextPollSeconds(policy, context) {
  const now = context.nowMs;
  const boundaries = [
    policy.maxIntervalSeconds ?? 300,
    secondsUntil(context.nextPlaylistTransitionMs, now),
    secondsUntil(context.nextClockBoundaryMs, now),
    secondsUntil(context.nextQuietHourBoundaryMs, now),
    secondsUntil(context.nextDashboardScheduleMs, now),
    secondsUntil(context.sourceValidityDeadlineMs, now)
  ].filter((value) => Number.isFinite(value) && value > 0);
  const minimum = Math.min(...boundaries);
  const withLimits = Math.max(policy.minIntervalSeconds ?? 30, Math.min(policy.maxIntervalSeconds ?? 300, minimum));
  return Math.round(withLimits);
}

function secondsUntil(targetMs, nowMs) {
  if (!targetMs) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
}

export function quietHourBoundary(now, quietHours, timezone = "UTC") {
  if (!quietHours?.enabled) return undefined;
  const minutes = minutesInTimezone(now, timezone);
  const start = parseTime(quietHours.start);
  const end = parseTime(quietHours.end);
  const active = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  const targetMinutes = active ? end : start;
  let delta = targetMinutes - minutes;
  if (delta <= 0) delta += 1440;
  return now.getTime() + delta * 60_000;
}

function minutesInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === "hour").value) * 60 + Number(parts.find((part) => part.type === "minute").value);
}

function parseTime(value) {
  const [hour, minute] = String(value).split(":").map(Number);
  return hour * 60 + minute;
}

export function createSnapshot(source, payload, diagnostics = {}) {
  const observedAt = diagnostics.observedAt ?? nowIso();
  return {
    id: `${source.id}:${sha256(`${observedAt}:${hashPayload(payload)}`).slice(0, 16)}`,
    sourceId: source.id,
    connectorId: source.connectorId,
    connectorVersion: source.connectorVersion ?? "1.0.0",
    outputSchemaVersion: source.outputSchemaVersion ?? "1.0.0",
    observedAt,
    receivedAt: nowIso(),
    state: diagnostics.state ?? "fresh",
    payload,
    payloadHash: hashPayload(payload),
    validUntil: diagnostics.validUntil ?? new Date(Date.now() + (source.validForSeconds ?? 900) * 1000).toISOString(),
    diagnostics: redact(diagnostics)
  };
}

export function createDashboardRevision(dashboard, definition) {
  const createdAt = nowIso();
  return {
    id: `${dashboard.id}:rev:${sha256(`${createdAt}:${hashPayload(definition)}`).slice(0, 16)}`,
    dashboardId: dashboard.id,
    schemaVersion: SCHEMA_VERSION,
    definition,
    definitionHash: hashPayload(definition),
    createdAt
  };
}

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    admin: { mode: "single-user-dev", pinHash: sha256("1111") },
    connectorManifests: connectorManifests(),
    connectorInstances: seedConnectorInstances(),
    snapshots: {},
    sourceHealth: {},
    dashboards: seedDashboards(),
    dashboardRevisions: {},
    renderArtifacts: {},
    devices: {},
    pairingCodes: {},
    deviceCommands: {},
    deviceCheckins: {},
    assignments: {},
    playlists: {
      workday: {
        id: "workday",
        name: "Workday rotation",
        entries: [
          { dashboardId: "work", durationSeconds: 900 },
          { dashboardId: "system", durationSeconds: 300 }
        ]
      }
    },
    jobs: [],
    auditEvents: []
  };
}

function connectorManifests() {
  const base = {
    timeoutMs: 5000,
    defaultCollectionIntervalSeconds: 300,
    minimumCollectionIntervalSeconds: 60,
    capabilityFlags: ["immutable-snapshots", "stable-hashing"]
  };
  return {
    "static.manual": {
      ...base,
      id: "static.manual",
      version: "1.0.0",
      displayName: "Static manual data",
      description: "A fixed JSON payload for fixtures, labels, and manually entered values.",
      executionLocation: "server",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { payload: { type: "object" } }, required: ["payload"] },
      secretFields: []
    },
    "http.json": {
      ...base,
      id: "http.json",
      version: "1.0.0",
      displayName: "HTTP JSON",
      description: "Fetches a JSON document with SSRF protection, optional headers, and size limits.",
      executionLocation: "server",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { url: { type: "string" }, method: { enum: ["GET", "POST"] }, headers: { type: "object" }, body: { type: "object" }, allowPrivateNetwork: { type: "boolean" } }, required: ["url"] },
      secretFields: ["headers.authorization"]
    },
    "webhook.json": {
      ...base,
      id: "webhook.json",
      version: "1.0.0",
      displayName: "Webhook JSON",
      description: "Stores the latest JSON payload posted by an external sender.",
      executionLocation: "webhook",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { initialPayload: { type: "object" } } },
      secretFields: ["token"]
    },
    "local.command.json": {
      ...base,
      id: "local.command.json",
      version: "1.0.0",
      displayName: "Local command JSON",
      description: "Runs an allowlisted command through the local agent and parses stdout as JSON.",
      executionLocation: "agent",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { executable: { type: "string" }, args: { type: "array", items: { type: "string" } } }, required: ["executable"] },
      secretFields: []
    },
    "file.json": {
      ...base,
      id: "file.json",
      version: "1.0.0",
      displayName: "JSON file",
      description: "Reads a JSON file from an allowed local path.",
      executionLocation: "agent",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      secretFields: []
    },
    "file.csv": {
      ...base,
      id: "file.csv",
      version: "1.0.0",
      displayName: "CSV file",
      description: "Reads a CSV file from an allowed local path and returns rows.",
      executionLocation: "agent",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      secretFields: []
    },
    "rss.atom": {
      ...base,
      id: "rss.atom",
      version: "1.0.0",
      displayName: "RSS or Atom",
      description: "Fetches feed metadata and recent entries.",
      executionLocation: "server",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { url: { type: "string" }, allowPrivateNetwork: { type: "boolean" } }, required: ["url"] },
      secretFields: []
    },
    "weather.open-meteo": {
      ...base,
      id: "weather.open-meteo",
      version: "1.0.0",
      displayName: "Weather",
      description: "Fetches current conditions and a short forecast from Open-Meteo, or fixture weather data offline.",
      executionLocation: "server",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { mode: { enum: ["fixture", "open-meteo"] }, locationName: { type: "string" }, latitude: { type: "number" }, longitude: { type: "number" }, timezone: { type: "string" }, units: { enum: ["metric", "imperial"] } }, required: ["mode"] },
      secretFields: []
    },
    "calendar.ics": {
      ...base,
      id: "calendar.ics",
      version: "1.0.0",
      displayName: "iCalendar URL",
      description: "Fetches upcoming events from an iCalendar feed or fixture calendar.",
      executionLocation: "server",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { url: { type: "string" }, allowPrivateNetwork: { type: "boolean" }, maxEvents: { type: "number" } }, required: ["url"] },
      secretFields: ["url"]
    },
    "github.repo": {
      ...base,
      id: "github.repo",
      version: "1.0.0",
      displayName: "GitHub repository",
      description: "Fetches public or token-authenticated GitHub repository metadata, issues, and pull requests.",
      executionLocation: "server",
      outputSchemaVersion: "1.0.0",
      configSchema: {
        type: "object",
        properties: {
          mode: { enum: ["fixture", "api"] },
          owner: { type: "string" },
          repo: { type: "string" },
          token: { type: "string" },
          includeIssues: { type: "boolean" },
          includePullRequests: { type: "boolean" }
        },
        required: ["mode"]
      },
      secretFields: ["token"]
    },
    "homeassistant.states": {
      ...base,
      id: "homeassistant.states",
      version: "1.0.0",
      displayName: "Home Assistant states",
      description: "Fetches selected Home Assistant entity states through the REST API, or fixture smart-home data offline.",
      executionLocation: "server",
      outputSchemaVersion: "1.0.0",
      configSchema: {
        type: "object",
        properties: {
          mode: { enum: ["fixture", "api"] },
          baseUrl: { type: "string" },
          token: { type: "string" },
          entityIds: { type: "array", items: { type: "string" } },
          maxEntities: { type: "number" },
          allowPrivateNetwork: { type: "boolean" }
        },
        required: ["mode"]
      },
      secretFields: ["token"]
    },
    "codexbar.usage": {
      ...base,
      id: "codexbar.usage",
      version: "1.0.0",
      displayName: "CodexBar usage",
      description: "Uses CodexBar local usage/cost data or fixture data in development.",
      executionLocation: "agent",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { mode: { enum: ["fixture", "local-http", "cli"] } }, required: ["mode"] },
      secretFields: []
    },
    "activitywatch.summary": {
      ...base,
      id: "activitywatch.summary",
      version: "1.0.0",
      displayName: "ActivityWatch summary",
      description: "Summarizes local ActivityWatch buckets through the agent without uploading raw titles by default.",
      executionLocation: "agent",
      outputSchemaVersion: "1.0.0",
      configSchema: { type: "object", properties: { mode: { enum: ["fixture", "local-http"] }, includeSensitiveTitles: { type: "boolean" } }, required: ["mode"] },
      secretFields: []
    }
  };
}

function seedConnectorInstances() {
  return {
    codexbar: { id: "codexbar", connectorId: "codexbar.usage", name: "CodexBar fixture", config: { mode: "fixture" }, validForSeconds: 900 },
    activitywatch: { id: "activitywatch", connectorId: "activitywatch.summary", name: "ActivityWatch fixture", config: { mode: "fixture", includeSensitiveTitles: false }, validForSeconds: 900 },
    httpfixture: { id: "httpfixture", connectorId: "http.json", name: "HTTP JSON fixture", config: { url: "fixture://http" }, validForSeconds: 900 },
    weather: { id: "weather", connectorId: "weather.open-meteo", name: "Weather fixture", config: { mode: "fixture", locationName: "San Francisco", units: "imperial" }, validForSeconds: 900 },
    calendar: { id: "calendar", connectorId: "calendar.ics", name: "Calendar fixture", config: { url: "fixture://calendar", maxEvents: 8 }, validForSeconds: 900 },
    github: { id: "github", connectorId: "github.repo", name: "GitHub fixture", config: { mode: "fixture", includeIssues: true, includePullRequests: true }, validForSeconds: 900 },
    homeassistant: { id: "homeassistant", connectorId: "homeassistant.states", name: "Home Assistant fixture", config: { mode: "fixture", maxEntities: 12 }, validForSeconds: 300 },
    manual: { id: "manual", connectorId: "static.manual", name: "Manual status", config: { payload: { metric: 73, alert: "All sample sources are healthy" } }, validForSeconds: 1800 }
  };
}

function seedDashboards() {
  const profiles = { width: 800, height: 600, palette: "monochrome", dither: "threshold", contrast: 1.1, gamma: 1 };
  return {
    work: {
      id: "work",
      name: "Work dashboard",
      archived: false,
      currentRevisionId: null,
      draft: {
        name: "Work dashboard",
        profile: profiles,
        widgets: [
          { id: "clock", type: "clock", title: "Now", x: 16, y: 14, w: 250, h: 92, sourceId: "manual", expression: "$" },
          { id: "codex", type: "progress", title: "Codex weekly usage", x: 282, y: 14, w: 250, h: 92, sourceId: "codexbar", expression: "$" },
          { id: "reset", type: "metric", title: "Reset", x: 548, y: 14, w: 236, h: 92, sourceId: "codexbar", expression: "$.resetAt", suffix: "" },
          { id: "active", type: "metric", title: "Active screen time", x: 16, y: 126, w: 250, h: 132, sourceId: "activitywatch", expression: "$.activeMinutes", suffix: " min" },
          { id: "apps", type: "list", title: "Top applications", x: 282, y: 126, w: 250, h: 276, sourceId: "activitywatch", expression: "$.topApplications" },
          { id: "hours", type: "bars", title: "Hourly activity", x: 548, y: 126, w: 236, h: 276, sourceId: "activitywatch", expression: "$.hourly" },
          { id: "fresh", type: "status", title: "Source freshness", x: 16, y: 422, w: 768, h: 150, sourceId: "httpfixture", expression: "$" }
        ]
      }
    },
    system: {
      id: "system",
      name: "System dashboard",
      archived: false,
      currentRevisionId: null,
      draft: {
        name: "System dashboard",
        profile: profiles,
        widgets: [
          { id: "health", type: "status", title: "Server health", x: 16, y: 14, w: 376, h: 130, sourceId: "httpfixture", expression: "$" },
          { id: "agent", type: "status", title: "Agent health", x: 408, y: 14, w: 376, h: 130, sourceId: "manual", expression: "$" },
          { id: "render", type: "metric", title: "Last render", x: 16, y: 164, w: 240, h: 120, sourceId: "manual", expression: "$.metric", suffix: "%" },
          { id: "device", type: "metric", title: "Device last seen", x: 280, y: 164, w: 240, h: 120, sourceId: "manual", expression: "$.metric", suffix: " sec" },
          { id: "db", type: "metric", title: "Database size", x: 544, y: 164, w: 240, h: 120, sourceId: "manual", expression: "$.metric", suffix: " KB" },
          { id: "connectors", type: "list", title: "Connector status", x: 16, y: 308, w: 768, h: 264, sourceId: "activitywatch", expression: "$.topApplications" }
        ]
      }
    },
    minimal: {
      id: "minimal",
      name: "Minimal dashboard",
      archived: false,
      currentRevisionId: null,
      draft: {
        name: "Minimal dashboard",
        profile: { ...profiles, width: 600, height: 800 },
        widgets: [
          { id: "clock", type: "clock", title: "Clock", x: 28, y: 34, w: 544, h: 250, sourceId: "manual", expression: "$" },
          { id: "date", type: "text", title: "Date", x: 28, y: 308, w: 544, h: 118, sourceId: "manual", expression: "$.alert" },
          { id: "metric", type: "metric", title: "Metric", x: 28, y: 452, w: 260, h: 180, sourceId: "manual", expression: "$.metric", suffix: "%" },
          { id: "alert", type: "alert", title: "Alert", x: 312, y: 452, w: 260, h: 180, sourceId: "manual", expression: "$.alert" }
        ]
      }
    }
  };
}

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}
