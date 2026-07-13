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
const loopbackHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
const adminToken = process.env.DASHBOARD_KINDLE_ADMIN_TOKEN ?? (loopbackHost ? "dev-admin-token" : "");
const adminCookieName = "dashboard_kindle_admin";
const dashboardWidgetTypes = new Set(["clock", "metric", "progress", "list", "bars", "status", "alert", "text"]);

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
  ensureInitialRevisions(state);
  return state;
}

export function saveState(state) {
  writeJson(statePath, state);
}

export async function bootstrapState(state = loadState()) {
  for (const instance of Object.values(state.connectorInstances)) {
    try {
      await collectSource(state, instance.id);
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
  if (request.method === "POST" && url.pathname.match(/^\/api\/v1\/sources\/[^/]+\/collect$/)) {
    const sourceId = url.pathname.split("/")[4];
    const snapshot = await collectSource(state, sourceId);
    saveState(state);
    return sendJson(response, 200, snapshot);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/dashboards") return sendJson(response, 200, Object.values(state.dashboards));
  if (request.method === "POST" && url.pathname === "/api/v1/dashboards") {
    const body = await readBody(request);
    if (!body.definition) throw httpError(400, "Dashboard definition is required");
    validateDashboardDefinition(body.definition, state);
    const id = body.id ?? `dashboard-${sha256(body.name ?? Date.now()).slice(0, 8)}`;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw httpError(400, "Dashboard id may only contain letters, numbers, underscores, and dashes");
    if (state.dashboards[id]) throw httpError(409, `Dashboard ${id} already exists`);
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
    connectorInstances: Object.values(state.connectorInstances).map((instance) => ({ ...instance, config: redact(instance.config) })),
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
  if (!adminToken) {
    console.error("DASHBOARD_KINDLE_ADMIN_TOKEN is required when binding outside loopback.");
    process.exit(1);
  }
  const state = loadState();
  saveState(state);
  const server = createAppServer(state);
  server.listen(port, host, () => {
    console.log(`dashboard-kindle listening on http://${host}:${port}`);
  });
}
