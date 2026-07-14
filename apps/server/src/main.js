import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { URL } from "node:url";
import {
  createDashboardRevision,
  defaultState,
  hashPayload,
  nowIso,
  readJson,
  redact,
  repoPath,
  sha256,
  writeJson
} from "../../../packages/domain/src/core.js";
import { collectConnector } from "../../../packages/connectors-built-in/src/connectors.js";
import { renderFingerprint, renderHtml, writeRenderArtifact } from "../../../packages/renderer/src/render.js";
import { createDeviceToken, hashDeviceToken, parseBearer, verifyDeviceToken, buildDisplayHeaders } from "../../../packages/device-protocol/src/protocol.js";
import { resolveProfile } from "../../../packages/device-profiles/src/profiles.js";
import { calculateWakeDecision } from "../../../packages/scheduling/src/scheduling.js";

loadEnvFile(repoPath(".env"));

const host = process.env.DASHBOARD_KINDLE_HOST ?? "127.0.0.1";
const port = Number(process.env.DASHBOARD_KINDLE_PORT ?? 8787);
const dataDir = path.resolve(process.env.DASHBOARD_KINDLE_DATA_DIR ?? repoPath("data"));
const statePath = path.join(dataDir, "state.json");
const publicDir = repoPath("apps/server/public");
const kindleClientDir = repoPath("clients/kindle-kual/dashboard-kindle");
const loopbackHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
const adminToken = process.env.DASHBOARD_KINDLE_ADMIN_TOKEN ?? (loopbackHost ? "dev-admin-token" : "");
const adminCookieName = "dashboard_kindle_admin";
const dashboardWidgetTypes = new Set(["clock", "metric", "progress", "list", "bars", "status", "alert", "text"]);
const schedulerTickMs = Number(process.env.DASHBOARD_KINDLE_SCHEDULER_TICK_MS ?? 5000);
const defaultSnapshotHistoryLimit = 25;
const refreshPresets = {
  battery_saver: {
    id: "battery_saver",
    label: "Battery Saver",
    minIntervalSeconds: 300,
    maxIntervalSeconds: 1800,
    fullRefreshInterval: 24,
    quietHours: { enabled: true, start: "22:00", end: "07:00" }
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    minIntervalSeconds: 60,
    maxIntervalSeconds: 300,
    fullRefreshInterval: 8,
    quietHours: { enabled: false, start: "22:00", end: "06:00" }
  },
  near_realtime: {
    id: "near_realtime",
    label: "Near Real-Time",
    minIntervalSeconds: 30,
    maxIntervalSeconds: 60,
    fullRefreshInterval: 4,
    quietHours: { enabled: false, start: "22:00", end: "06:00" }
  }
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadState() {
  const state = readJson(statePath, null) ?? defaultState();
  state.pairingCodes ??= {};
  state.deviceCommands ??= {};
  state.setup ??= { completed: false, completedSteps: [] };
  normalizeSnapshotHistory(state);
  ensureSourceJobs(state);
  ensureInitialRevisions(state);
  return state;
}

export function saveState(state) {
  writeJson(statePath, state);
}

export async function bootstrapState(state = loadState()) {
  for (const instance of Object.values(state.connectorInstances)) {
    try {
      await collectSource(state, instance.id, { updateSchedule: true });
    } catch {
      // Keep bootstrapping other fixture sources; individual connector health records carry the failure.
    }
  }
  for (const dashboard of Object.values(state.dashboards)) {
    publishDashboard(state, dashboard.id);
    renderDashboard(state, dashboard.id);
  }
  if (!Object.keys(state.devices).length) {
    enrollDevice(state, {
      name: "Simulator",
      capabilities: { profileId: "kindle_basic_600x800", width: 600, height: 800 }
    });
  }
  saveState(state);
  return state;
}

function ensureInitialRevisions(state) {
  for (const dashboard of Object.values(state.dashboards)) {
    if (!dashboard.currentRevisionId) {
      const revision = createDashboardRevision(dashboard, dashboard.draft);
      state.dashboardRevisions[revision.id] = revision;
      dashboard.currentRevisionId = revision.id;
    }
  }
}

function ensureSourceJobs(state, nowMs = Date.now()) {
  state.jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const sourceIds = new Set(Object.keys(state.connectorInstances ?? {}));
  state.jobs = state.jobs.filter((job) => job?.type !== "source.collect" || sourceIds.has(job.sourceId));
  for (const instance of Object.values(state.connectorInstances ?? {})) {
    const existing = sourceJob(state, instance.id);
    if (existing) {
      normalizeSourceJob(state, existing, instance, nowMs);
    } else {
      state.jobs.push(createSourceJob(state, instance, nowMs));
    }
  }
}

function sourceJob(state, sourceId) {
  return (state.jobs ?? []).find((job) => job.type === "source.collect" && job.sourceId === sourceId);
}

function createSourceJob(state, instance, nowMs = Date.now(), overrides = {}) {
  const intervalSeconds = normalizedCollectionInterval(state, instance, overrides.intervalSeconds ?? instance.collectionIntervalSeconds);
  const nextRunAt = overrides.nextRunAt ?? new Date(nowMs + initialCollectionDelaySeconds(instance.id, intervalSeconds) * 1000).toISOString();
  return {
    id: `source.collect:${instance.id}`,
    type: "source.collect",
    sourceId: instance.id,
    enabled: overrides.enabled ?? true,
    intervalSeconds,
    nextRunAt,
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    lastError: null,
    running: false,
    updatedAt: nowIso()
  };
}

function normalizeSourceJob(state, job, instance, nowMs = Date.now()) {
  job.id ??= `source.collect:${instance.id}`;
  job.sourceId = instance.id;
  job.enabled = job.enabled !== false;
  job.intervalSeconds = normalizedCollectionInterval(state, instance, job.intervalSeconds ?? instance.collectionIntervalSeconds);
  job.nextRunAt ??= new Date(nowMs + initialCollectionDelaySeconds(instance.id, job.intervalSeconds) * 1000).toISOString();
  job.lastRunAt ??= null;
  job.lastSuccessAt ??= null;
  job.lastErrorAt ??= null;
  job.consecutiveFailures = Number.isFinite(Number(job.consecutiveFailures)) ? Number(job.consecutiveFailures) : 0;
  job.lastError ??= null;
  job.running = false;
  job.updatedAt ??= nowIso();
}

function normalizedCollectionInterval(state, instance, requested) {
  const manifest = state.connectorManifests[instance.connectorId] ?? {};
  const minimum = Number(manifest.minimumCollectionIntervalSeconds ?? 60);
  const fallback = Number(manifest.defaultCollectionIntervalSeconds ?? 300);
  const value = Number(requested ?? fallback);
  return Math.max(minimum, Number.isFinite(value) && value > 0 ? Math.round(value) : fallback);
}

function deterministicJitterSeconds(sourceId, intervalSeconds, salt = "") {
  const maxJitter = Math.max(1, Math.min(30, Math.floor(intervalSeconds * 0.1)));
  const numeric = Number.parseInt(sha256(`${sourceId}:${salt}`).slice(0, 8), 16);
  return numeric % (maxJitter + 1);
}

function initialCollectionDelaySeconds(sourceId, intervalSeconds) {
  return Math.min(intervalSeconds, 30 + deterministicJitterSeconds(sourceId, intervalSeconds, "initial"));
}

function nextScheduledRunAt(sourceId, intervalSeconds, nowMs) {
  return new Date(nowMs + (intervalSeconds + deterministicJitterSeconds(sourceId, intervalSeconds, "schedule")) * 1000).toISOString();
}

function nextBackoffRunAt(sourceId, intervalSeconds, failures, nowMs) {
  const backoffSeconds = Math.min(3600, intervalSeconds * 2 ** Math.min(6, Math.max(0, failures - 1)));
  return new Date(nowMs + (backoffSeconds + deterministicJitterSeconds(sourceId, intervalSeconds, `backoff:${failures}`)) * 1000).toISOString();
}

function recordSourceJobSuccess(state, sourceId, nowMs = Date.now()) {
  ensureSourceJobs(state, nowMs);
  const job = sourceJob(state, sourceId);
  if (!job) return;
  job.lastRunAt = new Date(nowMs).toISOString();
  job.lastSuccessAt = job.lastRunAt;
  job.lastError = null;
  job.lastErrorAt = null;
  job.consecutiveFailures = 0;
  job.nextRunAt = nextScheduledRunAt(sourceId, job.intervalSeconds, nowMs);
  job.running = false;
  job.updatedAt = nowIso();
}

function recordSourceJobFailure(state, sourceId, error, nowMs = Date.now()) {
  ensureSourceJobs(state, nowMs);
  const job = sourceJob(state, sourceId);
  if (!job) return;
  job.lastRunAt = new Date(nowMs).toISOString();
  job.lastErrorAt = job.lastRunAt;
  job.lastError = error;
  job.consecutiveFailures = (job.consecutiveFailures ?? 0) + 1;
  job.nextRunAt = nextBackoffRunAt(sourceId, job.intervalSeconds, job.consecutiveFailures, nowMs);
  job.running = false;
  job.updatedAt = nowIso();
}

export async function runDueSourceJobs(state, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  ensureSourceJobs(state, nowMs);
  const due = state.jobs
    .filter((job) => job.type === "source.collect" && job.enabled && !job.running)
    .filter((job) => options.sourceIds ? options.sourceIds.includes(job.sourceId) : true)
    .filter((job) => Date.parse(job.nextRunAt) <= nowMs)
    .sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt))
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
  const results = [];
  for (const job of due) {
    job.running = true;
    job.lastRunAt = new Date(nowMs).toISOString();
    job.updatedAt = nowIso();
    try {
      const snapshot = await collectSource(state, job.sourceId, { updateSchedule: true, nowMs });
      results.push({ sourceId: job.sourceId, status: "success", snapshotId: snapshot.id, nextRunAt: sourceJob(state, job.sourceId)?.nextRunAt });
    } catch (error) {
      results.push({ sourceId: job.sourceId, status: "error", error: redactError(error), nextRunAt: sourceJob(state, job.sourceId)?.nextRunAt });
    } finally {
      const updated = sourceJob(state, job.sourceId);
      if (updated) updated.running = false;
    }
  }
  return { ran: results.length, results, nextRunAt: nextSchedulerWakeAt(state) };
}

function nextSchedulerWakeAt(state) {
  const timestamps = (state.jobs ?? [])
    .filter((job) => job.type === "source.collect" && job.enabled && !job.running)
    .map((job) => Date.parse(job.nextRunAt))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null;
}

function schedulerStatus(state) {
  ensureSourceJobs(state);
  return {
    nextRunAt: nextSchedulerWakeAt(state),
    jobs: state.jobs
      .filter((job) => job.type === "source.collect")
      .map((job) => publicSourceJob(job))
  };
}

function publicSourceJob(job) {
  const { lastError, ...publicJob } = job;
  return {
    ...publicJob,
    lastError: lastError ? redactError(lastError) : null,
    due: job.enabled && !job.running && Date.parse(job.nextRunAt) <= Date.now()
  };
}

function updateSourceSchedule(state, sourceId, input, nowMs = Date.now()) {
  const instance = state.connectorInstances[sourceId];
  if (!instance) throw httpError(404, `Unknown source ${sourceId}`);
  ensureSourceJobs(state, nowMs);
  const job = sourceJob(state, sourceId) ?? createSourceJob(state, instance, nowMs);
  if (!state.jobs.includes(job)) state.jobs.push(job);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw httpError(400, "Schedule enabled must be a boolean");
    job.enabled = input.enabled;
  }
  if (input.intervalSeconds !== undefined) {
    job.intervalSeconds = normalizedCollectionInterval(state, instance, input.intervalSeconds);
    instance.collectionIntervalSeconds = job.intervalSeconds;
  }
  if (input.runAt !== undefined) {
    const parsed = Date.parse(input.runAt);
    if (!Number.isFinite(parsed)) throw httpError(400, "Schedule runAt must be an ISO timestamp");
    job.nextRunAt = new Date(parsed).toISOString();
  } else if (input.intervalSeconds !== undefined || input.enabled === true) {
    job.nextRunAt = nextScheduledRunAt(sourceId, job.intervalSeconds, nowMs);
  }
  job.updatedAt = nowIso();
  audit(state, "source.schedule.updated", { sourceId, enabled: job.enabled, intervalSeconds: job.intervalSeconds, nextRunAt: job.nextRunAt });
  return publicSourceJob(job);
}

export async function collectSource(state, sourceId, options = {}) {
  const instance = state.connectorInstances[sourceId];
  if (!instance) throw httpError(404, `Unknown source ${sourceId}`);
  try {
    const snapshot = await collectConnector(instance);
    recordSourceSnapshot(state, sourceId, snapshot);
    state.sourceHealth[sourceId] = {
      sourceId,
      state: snapshot.state,
      lastSuccessAt: snapshot.receivedAt,
      snapshotAgeSeconds: 0,
      diagnostics: snapshot.diagnostics
    };
    if (options.updateSchedule) recordSourceJobSuccess(state, sourceId, options.nowMs ?? Date.now());
    audit(state, "source.collect.succeeded", { sourceId, snapshotId: snapshot.id });
    return snapshot;
  } catch (error) {
    state.sourceHealth[sourceId] = {
      sourceId,
      state: "error",
      lastErrorAt: nowIso(),
      error: redactError(error)
    };
    if (options.updateSchedule) recordSourceJobFailure(state, sourceId, redactError(error), options.nowMs ?? Date.now());
    audit(state, "source.collect.failed", { sourceId, error: redactError(error) });
    throw error;
  }
}

function normalizeSnapshotHistory(state) {
  state.snapshots ??= {};
  state.snapshotHistory = state.snapshotHistory && typeof state.snapshotHistory === "object" && !Array.isArray(state.snapshotHistory)
    ? state.snapshotHistory
    : {};
  state.retention = state.retention && typeof state.retention === "object" && !Array.isArray(state.retention)
    ? state.retention
    : {};
  state.retention.snapshotHistoryLimit = normalizedSnapshotHistoryLimit(state);
  for (const [sourceId, snapshot] of Object.entries(state.snapshots)) {
    if (!state.snapshotHistory[sourceId]?.length && snapshot) state.snapshotHistory[sourceId] = [snapshot];
  }
  for (const [sourceId, history] of Object.entries(state.snapshotHistory)) {
    if (!state.connectorInstances[sourceId]) {
      delete state.snapshotHistory[sourceId];
      continue;
    }
    state.snapshotHistory[sourceId] = dedupeSnapshots(Array.isArray(history) ? history : [])
      .slice(0, state.retention.snapshotHistoryLimit);
  }
}

function normalizedSnapshotHistoryLimit(state) {
  const requested = Number(state?.retention?.snapshotHistoryLimit ?? process.env.DASHBOARD_KINDLE_SNAPSHOT_HISTORY_LIMIT ?? defaultSnapshotHistoryLimit);
  if (!Number.isFinite(requested) || requested < 1) return defaultSnapshotHistoryLimit;
  return Math.min(500, Math.round(requested));
}

function recordSourceSnapshot(state, sourceId, snapshot) {
  normalizeSnapshotHistory(state);
  state.snapshots[sourceId] = snapshot;
  const limit = normalizedSnapshotHistoryLimit(state);
  const existing = state.snapshotHistory[sourceId] ?? [];
  state.snapshotHistory[sourceId] = dedupeSnapshots([snapshot, ...existing]).slice(0, limit);
  state.retention.snapshotHistoryLimit = limit;
}

function dedupeSnapshots(snapshots) {
  const seen = new Set();
  const filtered = [];
  for (const snapshot of snapshots) {
    if (!snapshot?.id || seen.has(snapshot.id)) continue;
    seen.add(snapshot.id);
    filtered.push(snapshot);
  }
  return filtered.sort((left, right) => Date.parse(right.receivedAt ?? right.observedAt ?? 0) - Date.parse(left.receivedAt ?? left.observedAt ?? 0));
}

export function publishDashboard(state, dashboardId) {
  const dashboard = state.dashboards[dashboardId];
  if (!dashboard) throw httpError(404, `Unknown dashboard ${dashboardId}`);
  validateDashboardDefinition(dashboard.draft, state);
  const current = state.dashboardRevisions[dashboard.currentRevisionId];
  const draftHash = hashPayload(dashboard.draft);
  if (current?.definitionHash === draftHash) return current;
  const revision = createDashboardRevision(dashboard, dashboard.draft);
  state.dashboardRevisions[revision.id] = revision;
  dashboard.currentRevisionId = revision.id;
  audit(state, "dashboard.published", { dashboardId, revisionId: revision.id });
  return revision;
}

export function renderDashboard(state, dashboardId, profileOverrides = {}) {
  const dashboard = state.dashboards[dashboardId];
  if (!dashboard) throw httpError(404, `Unknown dashboard ${dashboardId}`);
  const revision = state.dashboardRevisions[dashboard.currentRevisionId] ?? publishDashboard(state, dashboardId);
  const definition = revision.definition;
  const snapshots = snapshotsForDefinition(state, definition);
  const profile = resolveProfile(definition.profile, profileOverrides);
  const fingerprint = renderFingerprint(revision, snapshots, profile);
  const existing = Object.values(state.renderArtifacts).find((artifact) => artifact.fingerprint === fingerprint);
  if (existing && fs.existsSync(existing.imagePath)) return existing;
  const artifact = writeRenderArtifact({ definition, revision, snapshots, profile, dataDir });
  state.renderArtifacts[artifact.id] = artifact;
  audit(state, "dashboard.rendered", { dashboardId, revisionId: revision.id, artifactId: artifact.id });
  return artifact;
}

function snapshotsForDefinition(state, definition) {
  const sourceIds = [...new Set(definition.widgets.map((widget) => widget.sourceId).filter(Boolean))];
  return Object.fromEntries(sourceIds.map((sourceId) => [sourceId, state.snapshots[sourceId]]));
}

export function enrollDevice(state, input) {
  validateDeviceInput(input);
  const token = createDeviceToken();
  const id = input.id ?? `device-${sha256(`${input.name}:${Date.now()}`).slice(0, 10)}`;
  const profile = resolveProfile(input.capabilities ?? {}, input.profileOverrides ?? {});
  state.devices[id] = {
    id,
    name: input.name ?? "E-ink device",
    tokenHash: hashDeviceToken(token),
    createdAt: nowIso(),
    revokedAt: null,
    capabilities: input.capabilities ?? {},
    profile,
    pollPolicy: {
      minIntervalSeconds: 30,
      maxIntervalSeconds: 300,
      fullRefreshInterval: profile.fullRefreshInterval,
      quietHours: { enabled: false, start: "22:00", end: "06:00" },
      timezone: "America/Los_Angeles"
    }
  };
  const firstDashboard = Object.keys(state.dashboards)[0];
  state.assignments[id] = { deviceId: id, dashboardId: firstDashboard, assignedAt: nowIso() };
  audit(state, "device.enrolled", { deviceId: id });
  return { device: withoutToken(state.devices[id]), token };
}

function assignDevice(state, deviceId, dashboardId) {
  if (!state.devices[deviceId]) throw httpError(404, `Unknown device ${deviceId}`);
  if (!state.dashboards[dashboardId]) throw httpError(404, `Unknown dashboard ${dashboardId}`);
  state.assignments[deviceId] = { deviceId, dashboardId, assignedAt: nowIso() };
  audit(state, "device.assigned", { deviceId, dashboardId });
  return state.assignments[deviceId];
}

function updateDevicePolicy(state, deviceId, input) {
  const device = state.devices[deviceId];
  if (!device) throw httpError(404, `Unknown device ${deviceId}`);
  const current = device.pollPolicy ?? {};
  const preset = input.preset ? refreshPresets[input.preset] : null;
  if (input.preset && !preset) throw httpError(400, `Unknown refresh preset ${input.preset}`);
  const hasCustomFields = ["minIntervalSeconds", "maxIntervalSeconds", "fullRefreshInterval", "quietHours", "timezone"].some((key) => input[key] !== undefined);
  const next = {
    ...current,
    ...(preset ? {
      minIntervalSeconds: preset.minIntervalSeconds,
      maxIntervalSeconds: preset.maxIntervalSeconds,
      fullRefreshInterval: preset.fullRefreshInterval,
      quietHours: { ...preset.quietHours }
    } : {}),
    preset: input.preset ?? (hasCustomFields ? "custom" : current.preset ?? "custom")
  };
  if (input.minIntervalSeconds !== undefined) next.minIntervalSeconds = Number(input.minIntervalSeconds);
  if (input.maxIntervalSeconds !== undefined) next.maxIntervalSeconds = Number(input.maxIntervalSeconds);
  if (input.fullRefreshInterval !== undefined) next.fullRefreshInterval = Number(input.fullRefreshInterval);
  if (input.timezone !== undefined) next.timezone = String(input.timezone);
  if (input.quietHours !== undefined) next.quietHours = validateQuietHours(input.quietHours);
  validatePollPolicy(next);
  device.pollPolicy = next;
  audit(state, "device.policy.updated", { deviceId, preset: next.preset, minIntervalSeconds: next.minIntervalSeconds, maxIntervalSeconds: next.maxIntervalSeconds });
  return withoutToken(device);
}

function validatePollPolicy(policy) {
  for (const [key, minimum, maximum] of [
    ["minIntervalSeconds", 5, 86400],
    ["maxIntervalSeconds", 5, 86400],
    ["fullRefreshInterval", 1, 1000]
  ]) {
    const value = Number(policy[key]);
    if (!Number.isFinite(value) || value < minimum || value > maximum) throw httpError(400, `Device policy ${key} must be between ${minimum} and ${maximum}`);
    policy[key] = Math.round(value);
  }
  if (policy.minIntervalSeconds > policy.maxIntervalSeconds) throw httpError(400, "Device checks minimum must not exceed maximum");
  policy.quietHours = validateQuietHours(policy.quietHours ?? { enabled: false, start: "22:00", end: "06:00" });
  policy.timezone = policy.timezone || "America/Los_Angeles";
}

function validateQuietHours(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "Quiet hours must be an object");
  const quietHours = {
    enabled: Boolean(value.enabled),
    start: String(value.start ?? "22:00"),
    end: String(value.end ?? "06:00")
  };
  if (!/^\d{2}:\d{2}$/.test(quietHours.start) || !/^\d{2}:\d{2}$/.test(quietHours.end)) throw httpError(400, "Quiet hours start and end must use HH:MM");
  for (const key of ["start", "end"]) {
    const [hour, minute] = quietHours[key].split(":").map(Number);
    if (hour > 23 || minute > 59) throw httpError(400, "Quiet hours must be valid 24-hour times");
  }
  return quietHours;
}

function requestDeviceRefresh(state, deviceId) {
  const device = state.devices[deviceId];
  if (!device) throw httpError(404, `Unknown device ${deviceId}`);
  if (device.revokedAt) throw httpError(400, "Cannot request refresh for a revoked device");
  state.deviceCommands ??= {};
  state.deviceCommands[deviceId] = {
    ...(state.deviceCommands[deviceId] ?? {}),
    forceRefresh: true,
    requestedAt: nowIso()
  };
  audit(state, "device.refresh_requested", { deviceId });
  return publicDeviceCommand(state.deviceCommands[deviceId]);
}

function rotateDeviceToken(state, deviceId) {
  const device = state.devices[deviceId];
  if (!device) throw httpError(404, `Unknown device ${deviceId}`);
  const token = createDeviceToken();
  device.tokenHash = hashDeviceToken(token);
  device.revokedAt = null;
  device.tokenRotatedAt = nowIso();
  state.deviceCommands ??= {};
  delete state.deviceCommands[deviceId];
  audit(state, "device.token_rotated", { deviceId });
  return { device: withoutToken(device), token };
}

function revokeDevice(state, deviceId) {
  const device = state.devices[deviceId];
  if (!device) throw httpError(404, `Unknown device ${deviceId}`);
  device.revokedAt = nowIso();
  state.deviceCommands ??= {};
  delete state.deviceCommands[deviceId];
  audit(state, "device.revoked", { deviceId });
  return withoutToken(device);
}

function publicDeviceCommand(command) {
  if (!command) return null;
  return {
    forceRefresh: Boolean(command.forceRefresh),
    requestedAt: command.requestedAt ?? null
  };
}

function publicDeviceCommands(state) {
  return Object.fromEntries(Object.entries(state.deviceCommands ?? {}).map(([deviceId, command]) => [deviceId, publicDeviceCommand(command)]));
}

function createConnectorInstance(state, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "Source input must be an object");
  const connectorId = input.connectorId;
  const manifest = state.connectorManifests[connectorId];
  if (!manifest) throw httpError(400, `Unknown connector ${connectorId}`);
  const id = input.id ?? `source-${sha256(`${connectorId}:${input.name ?? ""}:${Date.now()}`).slice(0, 8)}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw httpError(400, "Source id may only contain letters, numbers, underscores, and dashes");
  if (state.connectorInstances[id]) throw httpError(409, `Source ${id} already exists`);
  const config = input.config ?? {};
  validateJsonSchema(config, manifest.configSchema, `Source ${id} configuration`);
  const instance = {
    id,
    connectorId,
    connectorVersion: manifest.version,
    outputSchemaVersion: manifest.outputSchemaVersion,
    name: input.name || manifest.displayName,
    config,
    collectionIntervalSeconds: normalizedCollectionInterval(state, { connectorId, collectionIntervalSeconds: input.collectionIntervalSeconds }, input.collectionIntervalSeconds),
    validForSeconds: input.validForSeconds ?? manifest.defaultCollectionIntervalSeconds * 3,
    timeoutMs: manifest.timeoutMs
  };
  state.connectorInstances[id] = instance;
  ensureSourceJobs(state);
  updateSourceSchedule(state, id, { intervalSeconds: instance.collectionIntervalSeconds });
  audit(state, "source.created", { sourceId: id, connectorId });
  return instance;
}

function validateJsonSchema(value, schema, label) {
  if (!schema) return;
  if (schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) throw httpError(400, `${label} must be an object`);
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) throw httpError(400, `${label} is missing required field ${key}`);
  }
  for (const [key, definition] of Object.entries(schema.properties ?? {})) {
    if (value[key] === undefined) continue;
    if (definition.enum && !definition.enum.includes(value[key])) throw httpError(400, `${label}.${key} must be one of ${definition.enum.join(", ")}`);
    if (definition.type && !matchesJsonType(value[key], definition.type)) throw httpError(400, `${label}.${key} must be ${definition.type}`);
  }
}

function matchesJsonType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value && typeof value === "object" && !Array.isArray(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return true;
}

function dashboardTemplates() {
  const profile = { width: 800, height: 600, palette: "monochrome", dither: "threshold", contrast: 1.1, gamma: 1 };
  return [
    {
      id: "blank",
      name: "Blank custom dashboard",
      description: "A clean starting point with one editable status widget.",
      definition: {
        name: "Blank custom dashboard",
        profile,
        widgets: [
          { id: "note", type: "text", title: "Note", x: 24, y: 24, w: 752, h: 160, sourceId: "manual", expression: "$.alert" }
        ]
      }
    },
    {
      id: "clock-status",
      name: "Clock and status",
      description: "Large clock, date, one metric, and a status message.",
      definition: {
        name: "Clock and status",
        profile: { ...profile, width: 600, height: 800 },
        widgets: [
          { id: "clock", type: "clock", title: "Now", x: 28, y: 32, w: 544, h: 230, sourceId: "manual", expression: "$" },
          { id: "metric", type: "metric", title: "Metric", x: 28, y: 300, w: 260, h: 180, sourceId: "manual", expression: "$.metric", suffix: "%" },
          { id: "status", type: "alert", title: "Status", x: 312, y: 300, w: 260, h: 180, sourceId: "manual", expression: "$.alert" }
        ]
      }
    },
    {
      id: "activity-work",
      name: "Work and activity",
      description: "Codex usage, ActivityWatch time, top apps, and source health.",
      definition: defaultState().dashboards.work.draft
    },
    {
      id: "rss-news",
      name: "News/RSS",
      description: "A feed-oriented list dashboard ready for an RSS source.",
      definition: {
        name: "News/RSS",
        profile,
        widgets: [
          { id: "headline", type: "status", title: "Feed title", x: 24, y: 24, w: 752, h: 110, sourceId: "httpfixture", expression: "$.message" },
          { id: "items", type: "list", title: "Latest entries", x: 24, y: 158, w: 752, h: 398, sourceId: "activitywatch", expression: "$.topApplications" }
        ]
      }
    },
    {
      id: "weather-clock",
      name: "Clock and weather",
      description: "A clock, current conditions, forecast, and status message.",
      definition: {
        name: "Clock and weather",
        profile,
        widgets: [
          { id: "clock", type: "clock", title: "Now", x: 24, y: 24, w: 240, h: 150, sourceId: "manual", expression: "$" },
          { id: "temp", type: "metric", title: "Temperature", x: 288, y: 24, w: 220, h: 150, sourceId: "weather", expression: "$.current.temperatureF", suffix: "F" },
          { id: "conditions", type: "status", title: "Conditions", x: 532, y: 24, w: 244, h: 150, sourceId: "weather", expression: "$.current" },
          { id: "forecast", type: "list", title: "Forecast", x: 24, y: 198, w: 752, h: 220, sourceId: "weather", expression: "$.daily" },
          { id: "note", type: "alert", title: "Status", x: 24, y: 442, w: 752, h: 114, sourceId: "manual", expression: "$.alert" }
        ]
      }
    },
    {
      id: "calendar-day",
      name: "Calendar day",
      description: "Upcoming calendar events with a compact status area.",
      definition: {
        name: "Calendar day",
        profile,
        widgets: [
          { id: "clock", type: "clock", title: "Now", x: 24, y: 24, w: 240, h: 150, sourceId: "manual", expression: "$" },
          { id: "events", type: "list", title: "Upcoming", x: 288, y: 24, w: 488, h: 360, sourceId: "calendar", expression: "$.events" },
          { id: "status", type: "status", title: "Calendar", x: 24, y: 408, w: 752, h: 148, sourceId: "calendar", expression: "$" }
        ]
      }
    },
    {
      id: "github-status",
      name: "GitHub status",
      description: "Repository summary, open issues, and pull requests from a GitHub source.",
      definition: {
        name: "GitHub status",
        profile,
        widgets: [
          { id: "repo", type: "status", title: "Repository", x: 24, y: 24, w: 488, h: 150, sourceId: "github", expression: "$.repository" },
          { id: "stars", type: "metric", title: "Stars", x: 536, y: 24, w: 240, h: 150, sourceId: "github", expression: "$.repository.stars", suffix: "" },
          { id: "issues", type: "list", title: "Open issues", x: 24, y: 198, w: 366, h: 220, sourceId: "github", expression: "$.issues" },
          { id: "pulls", type: "list", title: "Pull requests", x: 410, y: 198, w: 366, h: 220, sourceId: "github", expression: "$.pullRequests" },
          { id: "updated", type: "status", title: "Last updated", x: 24, y: 442, w: 752, h: 114, sourceId: "github", expression: "$.repository.updatedAt" }
        ]
      }
    },
    {
      id: "home-assistant-status",
      name: "Home Assistant status",
      description: "Smart-home summary with selected entity states and unavailable count.",
      definition: {
        name: "Home Assistant status",
        profile,
        widgets: [
          { id: "clock", type: "clock", title: "Now", x: 24, y: 24, w: 220, h: 150, sourceId: "manual", expression: "$" },
          { id: "summary", type: "alert", title: "Home", x: 268, y: 24, w: 508, h: 150, sourceId: "homeassistant", expression: "$.summary.message" },
          { id: "unavailable", type: "metric", title: "Unavailable", x: 24, y: 198, w: 220, h: 150, sourceId: "homeassistant", expression: "$.summary.unavailable", suffix: "" },
          { id: "on", type: "metric", title: "On", x: 268, y: 198, w: 220, h: 150, sourceId: "homeassistant", expression: "$.summary.on", suffix: "" },
          { id: "entities", type: "list", title: "Entities", x: 512, y: 198, w: 264, h: 220, sourceId: "homeassistant", expression: "$.entities" },
          { id: "updated", type: "status", title: "Updated", x: 24, y: 442, w: 752, h: 114, sourceId: "homeassistant", expression: "$.summary.updatedAt" }
        ]
      }
    }
  ];
}

function duplicateDashboard(state, dashboardId, input = {}) {
  const source = state.dashboards[dashboardId];
  if (!source) throw httpError(404, "Dashboard not found");
  const definition = structuredClone(source.draft);
  definition.name = input.name ?? `${source.name} copy`;
  const id = input.id ?? uniqueDashboardId(state, `${source.id}-copy`);
  validateDashboardId(state, id);
  validateDashboardDefinition(definition, state);
  state.dashboards[id] = { id, name: definition.name, archived: false, currentRevisionId: null, draft: definition };
  const revision = publishDashboard(state, id);
  audit(state, "dashboard.duplicated", { dashboardId, duplicateDashboardId: id });
  return { dashboard: state.dashboards[id], revision };
}

function archiveDashboard(state, dashboardId, archived) {
  const dashboard = state.dashboards[dashboardId];
  if (!dashboard) throw httpError(404, "Dashboard not found");
  dashboard.archived = Boolean(archived);
  audit(state, dashboard.archived ? "dashboard.archived" : "dashboard.restored", { dashboardId });
  return dashboard;
}

function deleteDashboard(state, dashboardId) {
  const dashboard = state.dashboards[dashboardId];
  if (!dashboard) throw httpError(404, "Dashboard not found");
  if (Object.keys(state.dashboards).length <= 1) throw httpError(400, "Cannot delete the last dashboard");
  const assignedDevices = Object.values(state.assignments ?? {}).filter((assignment) => assignment.dashboardId === dashboardId);
  if (assignedDevices.length) throw httpError(409, "Cannot delete a dashboard assigned to a device. Reassign or revoke the device first.");
  const revisionIds = Object.entries(state.dashboardRevisions)
    .filter(([, revision]) => revision.dashboardId === dashboardId)
    .map(([revisionId]) => revisionId);
  const artifactIds = Object.entries(state.renderArtifacts)
    .filter(([, artifact]) => artifact.dashboardId === dashboardId)
    .map(([artifactId]) => artifactId);
  for (const artifactId of artifactIds) {
    const artifact = state.renderArtifacts[artifactId];
    for (const filePath of [artifact.imagePath, artifact.svgPath, artifact.pgmPath]) {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    delete state.renderArtifacts[artifactId];
  }
  for (const revisionId of revisionIds) delete state.dashboardRevisions[revisionId];
  delete state.dashboards[dashboardId];
  audit(state, "dashboard.deleted", { dashboardId, revisionCount: revisionIds.length, artifactCount: artifactIds.length });
  return { deleted: true, dashboardId, revisionCount: revisionIds.length, artifactCount: artifactIds.length };
}

function exportDashboard(state, dashboardId) {
  const dashboard = state.dashboards[dashboardId];
  if (!dashboard) throw httpError(404, "Dashboard not found");
  return {
    kind: "dashboard-kindle.dashboard",
    version: 1,
    exportedAt: nowIso(),
    dashboard: {
      name: dashboard.name,
      archived: Boolean(dashboard.archived),
      definition: dashboard.draft
    }
  };
}

function importDashboard(state, input = {}) {
  const payload = input.dashboard?.definition ? input.dashboard : input;
  const definition = structuredClone(payload.definition ?? input.definition);
  if (!definition) throw httpError(400, "Dashboard import requires a definition");
  definition.name = input.name ?? payload.name ?? definition.name ?? "Imported dashboard";
  validateDashboardDefinition(definition, state);
  const id = input.id ?? uniqueDashboardId(state, slugifyDashboardId(definition.name || "imported-dashboard"));
  validateDashboardId(state, id);
  state.dashboards[id] = { id, name: definition.name, archived: false, currentRevisionId: null, draft: definition };
  const revision = publishDashboard(state, id);
  audit(state, "dashboard.imported", { dashboardId: id });
  return { dashboard: state.dashboards[id], revision };
}

function validateDashboardId(state, id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw httpError(400, "Dashboard id may only contain letters, numbers, underscores, and dashes");
  if (state.dashboards[id]) throw httpError(409, `Dashboard ${id} already exists`);
}

function uniqueDashboardId(state, baseId) {
  const base = slugifyDashboardId(baseId);
  let id = base;
  let index = 2;
  while (state.dashboards[id]) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

function slugifyDashboardId(value) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || `dashboard-${sha256(Date.now()).slice(0, 8)}`;
}

function createPairingCode(state, input, request) {
  cleanupPairingCodes(state);
  const enrollment = enrollDevice(state, input);
  const code = createPairingCodeValue();
  const serverUrl = input.serverUrl ?? publicBaseUrl(request);
  state.pairingCodes[code] = {
    code,
    deviceId: enrollment.device.id,
    token: enrollment.token,
    serverUrl,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
  };
  audit(state, "device.pairing_code.created", { deviceId: enrollment.device.id, code });
  return { code, expiresAt: state.pairingCodes[code].expiresAt, device: enrollment.device, bundleUrl: `/api/v1/pairing/${code}/kual-bundle.tgz` };
}

function createPairingCodeValue() {
  return Array.from(crypto.randomBytes(5))
    .map((byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte % 32])
    .join("");
}

function cleanupPairingCodes(state) {
  const now = Date.now();
  for (const [code, record] of Object.entries(state.pairingCodes ?? {})) {
    if (Date.parse(record.expiresAt) <= now) delete state.pairingCodes[code];
  }
}

function publicBaseUrl(request) {
  const proto = request.headers["x-forwarded-proto"] ?? "http";
  const hostHeader = request.headers["x-forwarded-host"] ?? request.headers.host;
  return `${proto}://${hostHeader}`;
}

function pairingBundle(state, code) {
  cleanupPairingCodes(state);
  const record = state.pairingCodes?.[code];
  if (!record) throw httpError(404, "Pairing code is invalid or expired");
  const files = {
    "dashboard-kindle/menu.json": fs.readFileSync(path.join(kindleClientDir, "menu.json")),
    "dashboard-kindle/bin/dashboard-kindle.sh": fs.readFileSync(path.join(kindleClientDir, "bin/dashboard-kindle.sh")),
    "dashboard-kindle/state/config": Buffer.from(`SERVER_URL=${record.serverUrl}\nDEVICE_TOKEN=${record.token}\nPOLL_SECONDS=300\n`)
  };
  return zlib.gzipSync(createTar(files));
}

function createTar(files) {
  const chunks = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    chunks.push(tarHeader(name, body.length));
    chunks.push(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  writeTarField(header, 0, 100, name);
  writeTarField(header, 100, 8, "0000755");
  writeTarField(header, 108, 8, "0000000");
  writeTarField(header, 116, 8, "0000000");
  writeTarField(header, 124, 12, size.toString(8).padStart(11, "0"));
  writeTarField(header, 136, 12, Math.floor(Date.now() / 1000).toString(8).padStart(11, "0"));
  header.fill(" ", 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarField(header, 257, 6, "ustar");
  writeTarField(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarField(header, 148, 8, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 32;
  return header;
}

function writeTarField(buffer, offset, length, value) {
  const text = String(value);
  buffer.write(text.slice(0, length - 1), offset, "utf8");
}

function getDeviceDisplay(state, request) {
  const token = parseBearer(request.headers.authorization);
  const device = Object.values(state.devices).find((candidate) => verifyDeviceToken(candidate, token));
  if (!device || device.revokedAt) throw httpError(401, "Invalid device token");
  const assignment = state.assignments[device.id];
  if (!assignment) throw httpError(404, "Device has no dashboard assignment");
  const artifact = renderDashboard(state, assignment.dashboardId, device.profile);
  const command = state.deviceCommands?.[device.id];
  const forceRefresh = Boolean(command?.forceRefresh);
  const wakeDecision = calculateWakeDecision(device.pollPolicy, {
    nowMs: Date.now(),
    nextClockBoundaryMs: Date.now() + 60_000,
    sourceValidityDeadlineMs: Math.min(...Object.values(state.snapshots).map((snapshot) => Date.parse(snapshot.validUntil)).filter(Number.isFinite)),
    changeCount: (state.deviceCheckins[device.id]?.successes ?? 0) + 1
  });
  if (forceRefresh) wakeDecision.fullRefresh = true;
  state.deviceCheckins[device.id] = {
    deviceId: device.id,
    lastSeenAt: nowIso(),
    currentArtifactId: artifact.id,
    currentImageHash: artifact.imageHash,
    nextPollSeconds: wakeDecision.nextPollSeconds,
    forcedRefreshAt: forceRefresh ? nowIso() : state.deviceCheckins[device.id]?.forcedRefreshAt,
    successes: (state.deviceCheckins[device.id]?.successes ?? 0) + 1
  };
  if (forceRefresh) delete state.deviceCommands[device.id];
  const ifNoneMatch = String(request.headers["if-none-match"] ?? "").replaceAll('"', "");
  if (ifNoneMatch === artifact.imageHash && !forceRefresh) {
    return {
      status: 304,
      headers: {
        ETag: `"${artifact.imageHash}"`,
        "X-Next-Poll-Seconds": String(wakeDecision.nextPollSeconds)
      },
      body: null
    };
  }
  return {
    status: 200,
    headers: buildDisplayHeaders(artifact, wakeDecision),
    body: fs.readFileSync(artifact.imagePath)
  };
}

function audit(state, action, details) {
  state.auditEvents.push({ id: sha256(`${Date.now()}:${action}:${state.auditEvents.length}`).slice(0, 16), at: nowIso(), action, details });
  state.auditEvents = state.auditEvents.slice(-500);
}

function withoutToken(device) {
  const { tokenHash, ...rest } = device;
  return rest;
}

function redactError(error) {
  return String(error?.message ?? error).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw httpError(413, "Request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length, ...securityHeaders(), ...headers });
  response.end(body);
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...securityHeaders(), ...headers });
  response.end(body);
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()"
  };
}

function parseCookies(header) {
  return Object.fromEntries(String(header ?? "").split(";").map((part) => {
    const index = part.indexOf("=");
    if (index === -1) return [part.trim(), ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function suppliedAdminToken(request) {
  const bearer = parseBearer(request.headers.authorization);
  const headerToken = request.headers["x-admin-token"];
  const cookies = parseCookies(request.headers.cookie);
  return bearer ?? headerToken ?? cookies[adminCookieName] ?? null;
}

function isAuthenticatedAdmin(request) {
  const supplied = suppliedAdminToken(request);
  return Boolean(adminToken && supplied && sha256(`admin:${supplied}`) === sha256(`admin:${adminToken}`));
}

function requireAdmin(request, url) {
  if (url.pathname === "/" || url.pathname === "/favicon.ico" || url.pathname.startsWith("/assets/")) return;
  if (request.method === "GET" && url.pathname === "/api/v1/health") return;
  if (request.method === "POST" && url.pathname === "/api/v1/admin/session") return;
  if (request.method === "DELETE" && url.pathname === "/api/v1/admin/session") return;
  if (request.method === "GET" && url.pathname === "/api/v1/device/display") return;
  if (request.method === "GET" && url.pathname.match(/^\/api\/v1\/pairing\/[^/]+\/kual-bundle\.tgz$/)) return;
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/webhooks\/[^/]+\/[^/]+$/)) return;
  if (!isAuthenticatedAdmin(request)) throw httpError(401, "Administrator authentication required");
}

function validateDashboardDefinition(definition, state) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw httpError(400, "Dashboard definition must be an object");
  if (definition.name !== undefined && typeof definition.name !== "string") throw httpError(400, "Dashboard definition name must be a string");
  const profile = definition.profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw httpError(400, "Dashboard definition profile is required");
  if (!Number.isFinite(Number(profile.width)) || Number(profile.width) < 100 || Number(profile.width) > 10000) throw httpError(400, "Dashboard profile width must be between 100 and 10000");
  if (!Number.isFinite(Number(profile.height)) || Number(profile.height) < 100 || Number(profile.height) > 10000) throw httpError(400, "Dashboard profile height must be between 100 and 10000");
  if (!Array.isArray(definition.widgets)) throw httpError(400, "Dashboard definition widgets must be an array");
  const widgetIds = new Set();
  for (const [index, widget] of definition.widgets.entries()) {
    if (!widget || typeof widget !== "object" || Array.isArray(widget)) throw httpError(400, `Widget ${index + 1} must be an object`);
    if (!widget.id || typeof widget.id !== "string") throw httpError(400, `Widget ${index + 1} must have a string id`);
    if (widgetIds.has(widget.id)) throw httpError(400, `Duplicate widget id ${widget.id}`);
    widgetIds.add(widget.id);
    if (!dashboardWidgetTypes.has(widget.type)) throw httpError(400, `Widget ${widget.id} has unknown type ${widget.type}`);
    if (!widget.sourceId || !state.connectorInstances[widget.sourceId]) throw httpError(400, `Widget ${widget.id} references unknown source ${widget.sourceId}`);
    for (const key of ["x", "y", "w", "h"]) {
      const value = Number(widget[key]);
      if (!Number.isFinite(value) || value < 0) throw httpError(400, `Widget ${widget.id} has invalid ${key}`);
    }
    if (Number(widget.w) < 24 || Number(widget.h) < 24) throw httpError(400, `Widget ${widget.id} is smaller than the minimum 24x24 layout`);
    if (Number(widget.x) + Number(widget.w) > Number(profile.width) || Number(widget.y) + Number(widget.h) > Number(profile.height)) {
      throw httpError(400, `Widget ${widget.id} extends outside the dashboard profile bounds`);
    }
    if (widget.expression !== undefined && typeof widget.expression !== "string") throw httpError(400, `Widget ${widget.id} expression must be a string`);
  }
}

function validateDeviceInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "Device enrollment input must be an object");
  if (input.name !== undefined && typeof input.name !== "string") throw httpError(400, "Device name must be a string");
  const capabilities = input.capabilities ?? {};
  if (typeof capabilities !== "object" || Array.isArray(capabilities)) throw httpError(400, "Device capabilities must be an object");
  for (const key of ["width", "height"]) {
    if (capabilities[key] !== undefined && (!Number.isFinite(Number(capabilities[key])) || Number(capabilities[key]) < 100)) {
      throw httpError(400, `Device capability ${key} must be a number greater than 100`);
    }
  }
  if (input.profileOverrides !== undefined && (typeof input.profileOverrides !== "object" || Array.isArray(input.profileOverrides))) {
    throw httpError(400, "Device profileOverrides must be an object");
  }
}

async function route(request, response, state) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  requireAdmin(request, url);
  if (request.method === "GET" && url.pathname === "/") return serveStatic(response, "index.html");
  if (request.method === "GET" && url.pathname === "/favicon.ico") return send(response, 204, null);
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) return serveStatic(response, url.pathname.replace("/assets/", ""));
  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    return sendJson(response, 200, { status: "ok", database: fs.existsSync(statePath) ? "persistent" : "memory", renderer: "imagemagick", adminAuth: Boolean(adminToken), at: nowIso() });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/admin/session") {
    const body = await readBody(request);
    if (!adminToken || body.token !== adminToken) throw httpError(401, "Invalid administrator token");
    return sendJson(response, 200, { status: "ok" }, {
      "Set-Cookie": `${adminCookieName}=${encodeURIComponent(body.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`
    });
  }
  if (request.method === "DELETE" && url.pathname === "/api/v1/admin/session") {
    return sendJson(response, 200, { status: "ok" }, {
      "Set-Cookie": `${adminCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
    });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/bootstrap") {
    await bootstrapState(state);
    return sendJson(response, 200, publicState(state));
  }
  if (request.method === "GET" && url.pathname === "/api/v1/state") return sendJson(response, 200, publicState(state));
  if (request.method === "GET" && url.pathname === "/api/v1/connectors/manifests") return sendJson(response, 200, Object.values(state.connectorManifests));
  if (request.method === "GET" && url.pathname === "/api/v1/refresh-presets") return sendJson(response, 200, Object.values(refreshPresets));
  if (request.method === "GET" && url.pathname === "/api/v1/scheduler") {
    return sendJson(response, 200, schedulerStatus(state));
  }
  if (request.method === "POST" && url.pathname === "/api/v1/scheduler/run-due") {
    const result = await runDueSourceJobs(state);
    saveState(state);
    return sendJson(response, 200, result);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/setup") {
    return sendJson(response, 200, setupStatus(state));
  }
  if (request.method === "POST" && url.pathname === "/api/v1/setup/complete") {
    state.setup = { completed: true, completedAt: nowIso(), completedSteps: setupStatus(state).steps.filter((step) => step.done).map((step) => step.id) };
    saveState(state);
    return sendJson(response, 200, state.setup);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/dashboard-templates") {
    return sendJson(response, 200, dashboardTemplates().map(({ definition, ...template }) => ({ ...template, preview: { widgets: definition.widgets.length, profile: definition.profile } })));
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/dashboard-templates\/[^/]+\/clone$/)) {
    const templateId = url.pathname.split("/")[4];
    const template = dashboardTemplates().find((item) => item.id === templateId);
    if (!template) throw httpError(404, "Dashboard template not found");
    const body = await readBody(request);
    const id = body.id ?? `${template.id}-${sha256(`${Date.now()}`).slice(0, 6)}`;
    validateDashboardId(state, id);
    const definition = structuredClone(template.definition);
    definition.name = body.name ?? template.name;
    validateDashboardDefinition(definition, state);
    state.dashboards[id] = { id, name: definition.name, archived: false, currentRevisionId: null, draft: definition };
    const revision = publishDashboard(state, id);
    saveState(state);
    return sendJson(response, 201, { dashboard: state.dashboards[id], revision });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/sources/test") {
    const input = await readBody(request);
    const manifest = state.connectorManifests[input.connectorId];
    if (!manifest) throw httpError(400, `Unknown connector ${input.connectorId}`);
    validateJsonSchema(input.config ?? {}, manifest.configSchema, "Source test configuration");
    const instance = {
      id: input.id ?? "source-test",
      connectorId: input.connectorId,
      connectorVersion: manifest.version,
      outputSchemaVersion: manifest.outputSchemaVersion,
      name: input.name ?? manifest.displayName,
      config: input.config ?? {},
      timeoutMs: manifest.timeoutMs,
      validForSeconds: manifest.defaultCollectionIntervalSeconds * 3
    };
    const snapshot = await collectConnector(instance);
    return sendJson(response, 200, { snapshot, fields: dataFields(snapshot.payload) });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/sources") {
    const input = await readBody(request);
    if (input.connectorId === "webhook.json" && !input.config?.token) {
      input.config ??= {};
      input.config.token = createDeviceToken();
    }
    const instance = createConnectorInstance(state, input);
    let snapshot = null;
    try {
      snapshot = await collectSource(state, instance.id);
    } catch {
      // Source health records the failure. Save the configured source so the user can fix it.
    }
    saveState(state);
    return sendJson(response, 201, {
      source: { ...instance, config: redact(instance.config) },
      snapshot,
      webhookUrl: instance.connectorId === "webhook.json" ? `/api/v1/webhooks/${instance.id}/${instance.config.token}` : null
    });
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/sources\/[^/]+\/collect$/)) {
    const sourceId = url.pathname.split("/")[4];
    try {
      const snapshot = await collectSource(state, sourceId, { updateSchedule: true });
      saveState(state);
      return sendJson(response, 200, snapshot);
    } catch (error) {
      saveState(state);
      throw error;
    }
  }
  if (request.method === "PATCH" && url.pathname.match(/^\/api\/v1\/sources\/[^/]+\/schedule$/)) {
    const sourceId = url.pathname.split("/")[4];
    const body = await readBody(request);
    const job = updateSourceSchedule(state, sourceId, body);
    saveState(state);
    return sendJson(response, 200, job);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/dashboards") return sendJson(response, 200, Object.values(state.dashboards));
  if (request.method === "POST" && url.pathname === "/api/v1/dashboards") {
    const body = await readBody(request);
    if (!body.definition) throw httpError(400, "Dashboard definition is required");
    validateDashboardDefinition(body.definition, state);
    const id = body.id ?? `dashboard-${sha256(body.name ?? Date.now()).slice(0, 8)}`;
    validateDashboardId(state, id);
    state.dashboards[id] = { id, name: body.name ?? "Untitled dashboard", archived: false, currentRevisionId: null, draft: body.definition };
    const revision = publishDashboard(state, id);
    saveState(state);
    return sendJson(response, 201, { dashboard: state.dashboards[id], revision });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/dashboards/import") {
    const body = await readBody(request);
    const imported = importDashboard(state, body);
    saveState(state);
    return sendJson(response, 201, imported);
  }
  if (request.method === "GET" && url.pathname.match(/^\/api\/v1\/dashboards\/[^/]+\/export$/)) {
    const id = url.pathname.split("/")[4];
    return sendJson(response, 200, exportDashboard(state, id), {
      "Content-Disposition": `attachment; filename="dashboard-kindle-${id}.json"`
    });
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/dashboards\/[^/]+\/duplicate$/)) {
    const id = url.pathname.split("/")[4];
    const body = await readBody(request);
    const duplicate = duplicateDashboard(state, id, body);
    saveState(state);
    return sendJson(response, 201, duplicate);
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/dashboards\/[^/]+\/archive$/)) {
    const id = url.pathname.split("/")[4];
    const body = await readBody(request);
    const dashboard = archiveDashboard(state, id, body.archived ?? true);
    saveState(state);
    return sendJson(response, 200, dashboard);
  }
  if (request.method === "DELETE" && url.pathname.match(/^\/api\/v1\/dashboards\/[^/]+$/)) {
    const id = url.pathname.split("/")[4];
    const result = deleteDashboard(state, id);
    saveState(state);
    return sendJson(response, 200, result);
  }
  if (request.method === "PATCH" && url.pathname.match(/^\/api\/v1\/dashboards\/[^/]+$/)) {
    const id = url.pathname.split("/")[4];
    const body = await readBody(request);
    const dashboard = state.dashboards[id];
    if (!dashboard) throw httpError(404, "Dashboard not found");
    if (body.name) dashboard.name = body.name;
    if (body.archived !== undefined) dashboard.archived = Boolean(body.archived);
    if (body.definition) {
      validateDashboardDefinition(body.definition, state);
      dashboard.draft = body.definition;
    }
    saveState(state);
    return sendJson(response, 200, dashboard);
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/dashboards\/[^/]+\/publish$/)) {
    const id = url.pathname.split("/")[4];
    const revision = publishDashboard(state, id);
    saveState(state);
    return sendJson(response, 200, revision);
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/dashboards\/[^/]+\/render$/)) {
    const id = url.pathname.split("/")[4];
    const body = await readBody(request);
    const artifact = renderDashboard(state, id, body.profileOverrides ?? {});
    saveState(state);
    return sendJson(response, 200, artifact);
  }
  if (request.method === "GET" && url.pathname.match(/^\/api\/v1\/render-artifacts\/[^/]+\/image$/)) {
    const artifactId = url.pathname.split("/")[4];
    const artifact = state.renderArtifacts[artifactId];
    if (!artifact || !fs.existsSync(artifact.imagePath)) throw httpError(404, "Render artifact not found");
    return send(response, 200, fs.readFileSync(artifact.imagePath), {
      "Content-Type": artifact.contentType,
      "ETag": `"${artifact.imageHash}"`,
      "X-Image-SHA256": artifact.imageHash
    });
  }
  if (request.method === "GET" && url.pathname.match(/^\/api\/v1\/dashboards\/[^/]+\/preview.svg$/)) {
    const id = url.pathname.split("/")[4];
    const dashboard = state.dashboards[id];
    if (!dashboard) throw httpError(404, "Dashboard not found");
    const revision = state.dashboardRevisions[dashboard.currentRevisionId];
    const html = renderHtml(revision.definition, snapshotsForDefinition(state, revision.definition));
    const svg = html.match(/<svg[\s\S]*<\/svg>/)?.[0] ?? "";
    return send(response, 200, svg, { "Content-Type": "image/svg+xml" });
  }
  if (request.method === "GET" && url.pathname.match(/^\/render\/[^/]+$/)) {
    const id = url.pathname.split("/")[2];
    const dashboard = state.dashboards[id];
    if (!dashboard) throw httpError(404, "Dashboard not found");
    const revision = state.dashboardRevisions[dashboard.currentRevisionId];
    return send(response, 200, renderHtml(revision.definition, snapshotsForDefinition(state, revision.definition)), { "Content-Type": "text/html" });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/devices/enroll") {
    const body = await readBody(request);
    const enrollment = enrollDevice(state, body);
    saveState(state);
    return sendJson(response, 201, enrollment);
  }
  if (request.method === "POST" && url.pathname === "/api/v1/devices/pairing-codes") {
    const body = await readBody(request);
    const pairing = createPairingCode(state, body, request);
    saveState(state);
    return sendJson(response, 201, pairing);
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/devices\/[^/]+\/assign$/)) {
    const deviceId = url.pathname.split("/")[4];
    const body = await readBody(request);
    const assignment = assignDevice(state, deviceId, body.dashboardId);
    saveState(state);
    return sendJson(response, 200, assignment);
  }
  if (request.method === "PATCH" && url.pathname.match(/^\/api\/v1\/devices\/[^/]+\/policy$/)) {
    const deviceId = url.pathname.split("/")[4];
    const body = await readBody(request);
    const device = updateDevicePolicy(state, deviceId, body);
    saveState(state);
    return sendJson(response, 200, device);
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/devices\/[^/]+\/refresh-next-poll$/)) {
    const deviceId = url.pathname.split("/")[4];
    const command = requestDeviceRefresh(state, deviceId);
    saveState(state);
    return sendJson(response, 202, command);
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/devices\/[^/]+\/rotate-token$/)) {
    const deviceId = url.pathname.split("/")[4];
    const rotation = rotateDeviceToken(state, deviceId);
    saveState(state);
    return sendJson(response, 200, rotation);
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/devices\/[^/]+\/revoke$/)) {
    const deviceId = url.pathname.split("/")[4];
    const device = revokeDevice(state, deviceId);
    saveState(state);
    return sendJson(response, 200, device);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/device/display") {
    const display = getDeviceDisplay(state, request);
    saveState(state);
    return send(response, display.status, display.body, display.headers);
  }
  if (request.method === "GET" && url.pathname.match(/^\/api\/v1\/pairing\/[^/]+\/kual-bundle\.tgz$/)) {
    const code = url.pathname.split("/")[4];
    const bundle = pairingBundle(state, code);
    return send(response, 200, bundle, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="dashboard-kindle-${code}.tgz"`
    });
  }
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/webhooks\/[^/]+\/[^/]+$/)) {
    const [, , , , sourceId, token] = url.pathname.split("/");
    const instance = state.connectorInstances[sourceId];
    if (!instance || instance.connectorId !== "webhook.json" || instance.config.token !== token) throw httpError(404, "Webhook not found");
    const payload = await readBody(request);
    instance.config.latestPayload = payload;
    const snapshot = await collectSource(state, sourceId);
    saveState(state);
    return sendJson(response, 202, { snapshotId: snapshot.id, payloadHash: snapshot.payloadHash });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/diagnostics") {
    return sendJson(response, 200, {
      health: "ok",
      sources: state.sourceHealth,
      snapshotHistory: publicSnapshotHistory(state, { includePayload: false }),
      devices: Object.values(state.devices).map(withoutToken),
      deviceCommands: publicDeviceCommands(state),
      checkins: state.deviceCheckins,
      artifacts: Object.values(state.renderArtifacts).map((artifact) => ({ ...artifact, imagePath: path.relative(repoPath(), artifact.imagePath) })),
      scheduler: schedulerStatus(state),
      auditEvents: state.auditEvents.slice(-50)
    });
  }
  throw httpError(404, "Not found");
}

function publicState(state) {
  cleanupPairingCodes(state);
  return {
    connectorManifests: Object.values(state.connectorManifests),
    connectorInstances: Object.values(state.connectorInstances).map((instance) => ({ ...instance, config: redact(instance.config) })),
    snapshots: state.snapshots,
    snapshotHistory: publicSnapshotHistory(state, { includePayload: true }),
    sourceHealth: state.sourceHealth,
    retention: state.retention,
    dashboards: Object.values(state.dashboards),
    dashboardRevisions: Object.values(state.dashboardRevisions),
    renderArtifacts: Object.values(state.renderArtifacts).map((artifact) => ({ ...artifact, imagePath: path.relative(repoPath(), artifact.imagePath), svgPath: path.relative(repoPath(), artifact.svgPath), pgmPath: path.relative(repoPath(), artifact.pgmPath) })),
    devices: Object.values(state.devices).map(withoutToken),
    assignments: state.assignments,
    deviceCommands: publicDeviceCommands(state),
    deviceCheckins: state.deviceCheckins,
    scheduler: schedulerStatus(state),
    setup: setupStatus(state),
    pairingCodes: Object.values(state.pairingCodes ?? {}).map(({ token, ...record }) => record)
  };
}

function publicSnapshotHistory(state, options = {}) {
  normalizeSnapshotHistory(state);
  return Object.fromEntries(Object.entries(state.snapshotHistory).map(([sourceId, history]) => [
    sourceId,
    history.map((snapshot) => ({
      id: snapshot.id,
      sourceId: snapshot.sourceId,
      connectorId: snapshot.connectorId,
      observedAt: snapshot.observedAt,
      receivedAt: snapshot.receivedAt,
      state: snapshot.state,
      payloadHash: snapshot.payloadHash,
      ...(options.includePayload ? { payload: snapshot.payload } : {}),
      validUntil: snapshot.validUntil,
      diagnostics: snapshot.diagnostics
    }))
  ]));
}

function dataFields(value, prefix = "$") {
  if (Array.isArray(value)) {
    return value.slice(0, 5).flatMap((item, index) => dataFields(item, `${prefix}.${index}`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => {
      const pathName = `${prefix}.${key}`;
      return [{ path: pathName, type: Array.isArray(item) ? "array" : typeof item, sample: summarizeFieldSample(item) }, ...dataFields(item, pathName)];
    }).slice(0, 100);
  }
  return [];
}

function summarizeFieldSample(value) {
  if (Array.isArray(value)) return `${value.length} items`;
  if (value && typeof value === "object") return `${Object.keys(value).length} fields`;
  return value;
}

function setupStatus(state) {
  const sourceCount = Object.keys(state.connectorInstances ?? {}).length;
  const deviceCount = Object.keys(state.devices ?? {}).length;
  const renderedCount = Object.keys(state.renderArtifacts ?? {}).length;
  const assignedCount = Object.keys(state.assignments ?? {}).length;
  const steps = [
    { id: "admin", label: "Create an admin account", done: Boolean(adminToken) },
    { id: "health", label: "Confirm server and renderer health", done: true },
    { id: "source", label: "Add the first data source", done: sourceCount > 0 },
    { id: "template", label: "Choose a dashboard template", done: Object.keys(state.dashboards ?? {}).length > 0 },
    { id: "device", label: "Pair a device", done: deviceCount > 0 },
    { id: "screen", label: "Send and verify a test screen", done: renderedCount > 0 && assignedCount > 0 },
    { id: "refresh", label: "Configure refresh and quiet hours", done: deviceCount > 0 }
  ];
  return { completed: Boolean(state.setup?.completed), steps, nextStep: steps.find((step) => !step.done)?.id ?? "complete" };
}

function serveStatic(response, fileName) {
  const safeName = path.normalize(fileName).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safeName);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath)) throw httpError(404, "Static asset not found");
  const ext = path.extname(filePath);
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
  send(response, 200, fs.readFileSync(filePath), { "Content-Type": types[ext] ?? "application/octet-stream" });
}

export function createAppServer(state = loadState()) {
  return http.createServer(async (request, response) => {
    try {
      await route(request, response, state);
    } catch (error) {
      const status = error.status ?? 500;
      sendJson(response, status, { error: redactError(error), status });
    }
  });
}

export function startSourceScheduler(state, options = {}) {
  const intervalMs = options.intervalMs ?? schedulerTickMs;
  if (intervalMs <= 0) return { stop() {} };
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const result = await runDueSourceJobs(state);
      if (result.ran > 0) saveState(state);
    } catch (error) {
      audit(state, "scheduler.tick.failed", { error: redactError(error) });
      saveState(state);
    } finally {
      running = false;
    }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return {
    stop() {
      clearInterval(timer);
    }
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (!adminToken) {
    console.error("DASHBOARD_KINDLE_ADMIN_TOKEN is required when binding outside loopback.");
    process.exit(1);
  }
  const state = loadState();
  saveState(state);
  const server = createAppServer(state);
  startSourceScheduler(state);
  server.listen(port, host, () => {
    console.log(`dashboard-kindle listening on http://${host}:${port}`);
  });
}
