import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import {
  createDashboardRevision,
  defaultState,
  hashPayload,
  nowIso,
  readJson,
  repoPath,
  sha256,
  writeJson
} from "../../../packages/domain/src/core.js";
import { collectConnector } from "../../../packages/connectors-built-in/src/connectors.js";
import { renderFingerprint, renderHtml, writeRenderArtifact } from "../../../packages/renderer/src/render.js";
import { createDeviceToken, hashDeviceToken, parseBearer, verifyDeviceToken, buildDisplayHeaders } from "../../../packages/device-protocol/src/protocol.js";
import { resolveProfile } from "../../../packages/device-profiles/src/profiles.js";
import { calculateWakeDecision } from "../../../packages/scheduling/src/scheduling.js";

const host = process.env.DASHBOARD_KINDLE_HOST ?? "127.0.0.1";
const port = Number(process.env.DASHBOARD_KINDLE_PORT ?? 8787);
const dataDir = path.resolve(process.env.DASHBOARD_KINDLE_DATA_DIR ?? repoPath("data"));
const statePath = path.join(dataDir, "state.json");
const publicDir = repoPath("apps/server/public");

export function loadState() {
  const state = readJson(statePath, null) ?? defaultState();
  ensureInitialRevisions(state);
  return state;
}

export function saveState(state) {
  writeJson(statePath, state);
}

export async function bootstrapState(state = loadState()) {
  for (const instance of Object.values(state.connectorInstances)) {
    await collectSource(state, instance.id);
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

export async function collectSource(state, sourceId) {
  const instance = state.connectorInstances[sourceId];
  if (!instance) throw httpError(404, `Unknown source ${sourceId}`);
  try {
    const snapshot = await collectConnector(instance);
    state.snapshots[sourceId] = snapshot;
    state.sourceHealth[sourceId] = {
      sourceId,
      state: snapshot.state,
      lastSuccessAt: snapshot.receivedAt,
      snapshotAgeSeconds: 0,
      diagnostics: snapshot.diagnostics
    };
    audit(state, "source.collect.succeeded", { sourceId, snapshotId: snapshot.id });
    return snapshot;
  } catch (error) {
    state.sourceHealth[sourceId] = {
      sourceId,
      state: "error",
      lastErrorAt: nowIso(),
      error: redactError(error)
    };
    audit(state, "source.collect.failed", { sourceId, error: redactError(error) });
    throw error;
  }
}

export function publishDashboard(state, dashboardId) {
  const dashboard = state.dashboards[dashboardId];
  if (!dashboard) throw httpError(404, `Unknown dashboard ${dashboardId}`);
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

function getDeviceDisplay(state, request) {
  const token = parseBearer(request.headers.authorization);
  const device = Object.values(state.devices).find((candidate) => verifyDeviceToken(candidate, token));
  if (!device || device.revokedAt) throw httpError(401, "Invalid device token");
  const assignment = state.assignments[device.id];
  if (!assignment) throw httpError(404, "Device has no dashboard assignment");
  const artifact = renderDashboard(state, assignment.dashboardId, device.profile);
  const wakeDecision = calculateWakeDecision(device.pollPolicy, {
    nowMs: Date.now(),
    nextClockBoundaryMs: Date.now() + 60_000,
    sourceValidityDeadlineMs: Math.min(...Object.values(state.snapshots).map((snapshot) => Date.parse(snapshot.validUntil)).filter(Number.isFinite)),
    changeCount: (state.deviceCheckins[device.id]?.successes ?? 0) + 1
  });
  state.deviceCheckins[device.id] = {
    deviceId: device.id,
    lastSeenAt: nowIso(),
    currentArtifactId: artifact.id,
    currentImageHash: artifact.imageHash,
    nextPollSeconds: wakeDecision.nextPollSeconds,
    successes: (state.deviceCheckins[device.id]?.successes ?? 0) + 1
  };
  const ifNoneMatch = String(request.headers["if-none-match"] ?? "").replaceAll('"', "");
  if (ifNoneMatch === artifact.imageHash) {
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
  return text ? JSON.parse(text) : {};
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

async function route(request, response, state) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === "GET" && url.pathname === "/") return serveStatic(response, "index.html");
  if (request.method === "GET" && url.pathname === "/favicon.ico") return send(response, 204, null);
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) return serveStatic(response, url.pathname.replace("/assets/", ""));
  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    return sendJson(response, 200, { status: "ok", database: fs.existsSync(statePath) ? "persistent" : "memory", renderer: "imagemagick", at: nowIso() });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/bootstrap") {
    await bootstrapState(state);
    return sendJson(response, 200, publicState(state));
  }
  if (request.method === "GET" && url.pathname === "/api/v1/state") return sendJson(response, 200, publicState(state));
  if (request.method === "GET" && url.pathname === "/api/v1/connectors/manifests") return sendJson(response, 200, Object.values(state.connectorManifests));
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/sources\/[^/]+\/collect$/)) {
    const sourceId = url.pathname.split("/")[4];
    const snapshot = await collectSource(state, sourceId);
    saveState(state);
    return sendJson(response, 200, snapshot);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/dashboards") return sendJson(response, 200, Object.values(state.dashboards));
  if (request.method === "POST" && url.pathname === "/api/v1/dashboards") {
    const body = await readBody(request);
    const id = body.id ?? `dashboard-${sha256(body.name ?? Date.now()).slice(0, 8)}`;
    state.dashboards[id] = { id, name: body.name ?? "Untitled dashboard", archived: false, currentRevisionId: null, draft: body.definition };
    const revision = publishDashboard(state, id);
    saveState(state);
    return sendJson(response, 201, { dashboard: state.dashboards[id], revision });
  }
  if (request.method === "PATCH" && url.pathname.match(/^\/api\/v1\/dashboards\/[^/]+$/)) {
    const id = url.pathname.split("/")[4];
    const body = await readBody(request);
    const dashboard = state.dashboards[id];
    if (!dashboard) throw httpError(404, "Dashboard not found");
    if (body.name) dashboard.name = body.name;
    if (body.definition) dashboard.draft = body.definition;
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
    const artifact = renderDashboard(state, id);
    saveState(state);
    return sendJson(response, 200, artifact);
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
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/devices\/[^/]+\/assign$/)) {
    const deviceId = url.pathname.split("/")[4];
    const body = await readBody(request);
    const assignment = assignDevice(state, deviceId, body.dashboardId);
    saveState(state);
    return sendJson(response, 200, assignment);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/device/display") {
    const display = getDeviceDisplay(state, request);
    saveState(state);
    return send(response, display.status, display.body, display.headers);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/diagnostics") {
    return sendJson(response, 200, {
      health: "ok",
      sources: state.sourceHealth,
      devices: Object.values(state.devices).map(withoutToken),
      checkins: state.deviceCheckins,
      artifacts: Object.values(state.renderArtifacts).map((artifact) => ({ ...artifact, imagePath: path.relative(repoPath(), artifact.imagePath) })),
      auditEvents: state.auditEvents.slice(-50)
    });
  }
  throw httpError(404, "Not found");
}

function publicState(state) {
  return {
    connectorManifests: Object.values(state.connectorManifests),
    connectorInstances: Object.values(state.connectorInstances),
    snapshots: state.snapshots,
    sourceHealth: state.sourceHealth,
    dashboards: Object.values(state.dashboards),
    dashboardRevisions: Object.values(state.dashboardRevisions),
    renderArtifacts: Object.values(state.renderArtifacts).map((artifact) => ({ ...artifact, imagePath: path.relative(repoPath(), artifact.imagePath), svgPath: path.relative(repoPath(), artifact.svgPath), pgmPath: path.relative(repoPath(), artifact.pgmPath) })),
    devices: Object.values(state.devices).map(withoutToken),
    assignments: state.assignments,
    deviceCheckins: state.deviceCheckins
  };
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

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const state = await bootstrapState(loadState());
  const server = createAppServer(state);
  server.listen(port, host, () => {
    console.log(`dashboard-kindle listening on http://${host}:${port}`);
  });
}
