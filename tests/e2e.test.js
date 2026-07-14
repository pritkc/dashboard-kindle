import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { bootstrapState, cleanupRenderArtifacts, createAppServer, decryptConnectorSecretsInPlace, loadState, stateForStorage } from "../apps/server/src/main.js";
import { sha256 } from "../packages/domain/src/core.js";

const adminHeaders = { "X-Admin-Token": "dev-admin-token" };

test("fixture connector to device display path returns image and then 304", async (t) => {
  const state = await bootstrapState(loadState());
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const enrollment = await postJson(`${base}/api/v1/devices/enroll`, {
    name: "test simulator",
    capabilities: { profileId: "kindle_basic_600x800" }
  });
  await postJson(`${base}/api/v1/devices/${enrollment.device.id}/assign`, { dashboardId: "system" });

  const first = await fetch(`${base}/api/v1/device/display`, {
    headers: { Authorization: `Bearer ${enrollment.token}` }
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/png");
  const body = Buffer.from(await first.arrayBuffer());
  assert.equal(body[0], 0x89);
  assert.equal(first.headers.get("x-image-sha256"), sha256(body));
  assert.ok(Number(first.headers.get("x-next-poll-seconds")) > 0);

  const second = await fetch(`${base}/api/v1/device/display`, {
    headers: {
      Authorization: `Bearer ${enrollment.token}`,
      "If-None-Match": first.headers.get("etag")
    }
  });
  assert.equal(second.status, 304);
});

test("invalid device token is rejected", async (t) => {
  const state = await bootstrapState(loadState());
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/device/display`, {
    headers: { Authorization: "Bearer invalid" }
  });
  assert.equal(response.status, 401);
});

test("control-plane routes require administrator authentication", async (t) => {
  const state = await bootstrapState(loadState());
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/state`);
  assert.equal(response.status, 401);
  const authed = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/state`, { headers: adminHeaders });
  assert.equal(authed.status, 200);
});

test("dashboard writes reject invalid definitions", async (t) => {
  const state = await bootstrapState(loadState());
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/v1/dashboards/work`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({
      definition: {
        name: "Broken",
        profile: { width: 800, height: 600 },
        widgets: [{ id: "bad", type: "metric", sourceId: "missing", x: 0, y: 0, w: 100, h: 100 }]
      }
    })
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /unknown source/);
});

test("setup, templates, sources, webhooks, and pairing bundle support guided setup", async (t) => {
  const state = await bootstrapState(loadState());
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = Date.now().toString(36);

  const setup = await getJson(`${base}/api/v1/setup`);
  assert.equal(setup.nextStep, "complete");
  assert.ok(setup.steps.some((step) => step.id === "device" && step.done));

  const templates = await getJson(`${base}/api/v1/dashboard-templates`);
  assert.ok(templates.some((template) => template.id === "clock-status"));
  const cloned = await postJson(`${base}/api/v1/dashboard-templates/clock-status/clone`, {
    id: `clock-${suffix}`,
    name: "Clock test"
  });
  assert.equal(cloned.dashboard.name, "Clock test");

  const sourceTest = await postJson(`${base}/api/v1/sources/test`, {
    connectorId: "static.manual",
    config: { payload: { metric: 88, alert: "Source wizard works" } }
  });
  assert.ok(sourceTest.fields.some((field) => field.path === "$.metric"));

  const webhook = await postJson(`${base}/api/v1/sources`, {
    id: `hook-${suffix}`,
    connectorId: "webhook.json",
    name: "Webhook test",
    config: { initialPayload: { message: "pending" } }
  });
  assert.match(webhook.webhookUrl, /^\/api\/v1\/webhooks\/hook-/);
  const webhookPost = await fetch(`${base}${webhook.webhookUrl}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "delivered", count: 2 })
  });
  assert.equal(webhookPost.status, 202);

  const pairing = await postJson(`${base}/api/v1/devices/pairing-codes`, {
    name: "Pairing test",
    serverUrl: base,
    capabilities: { profileId: "kindle_basic_600x800" }
  });
  const bundle = await fetch(`${base}${pairing.bundleUrl}`);
  assert.equal(bundle.status, 200);
  const unpacked = zlib.gunzipSync(Buffer.from(await bundle.arrayBuffer())).toString("utf8");
  assert.match(unpacked, new RegExp(`SERVER_URL=${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(unpacked, /DEVICE_TOKEN=/);

  const publicState = await getJson(`${base}/api/v1/state`);
  const publicPairing = publicState.pairingCodes.find((record) => record.code === pairing.code);
  assert.equal(publicPairing.token, undefined);
  assert.equal(publicPairing.deviceId, pairing.device.id);
});

test("source scheduler runs due jobs and backs off failures", async (t) => {
  const state = loadState();
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = Date.now().toString(36);

  const initial = await getJson(`${base}/api/v1/scheduler`);
  assert.ok(initial.jobs.some((job) => job.sourceId === "manual"));

  await patchJson(`${base}/api/v1/sources/manual/schedule`, {
    intervalSeconds: 60,
    runAt: "1970-01-01T00:00:00.000Z"
  });
  const success = await postJson(`${base}/api/v1/scheduler/run-due`, {});
  assert.equal(success.ran, 1);
  assert.equal(success.results[0].sourceId, "manual");
  assert.equal(success.results[0].status, "success");
  const afterSuccess = await getJson(`${base}/api/v1/state`);
  const manualJob = afterSuccess.scheduler.jobs.find((job) => job.sourceId === "manual");
  assert.equal(manualJob.consecutiveFailures, 0);
  assert.ok(Date.parse(manualJob.nextRunAt) > Date.now());

  const broken = await postJson(`${base}/api/v1/sources`, {
    id: `blocked-${suffix}`,
    connectorId: "http.json",
    name: "Blocked private HTTP",
    collectionIntervalSeconds: 60,
    config: { url: "http://127.0.0.1/private" }
  });
  assert.equal(broken.snapshot, null);
  await patchJson(`${base}/api/v1/sources/blocked-${suffix}/schedule`, {
    intervalSeconds: 60,
    runAt: "1970-01-01T00:00:00.000Z"
  });
  const failure = await postJson(`${base}/api/v1/scheduler/run-due`, {});
  assert.equal(failure.ran, 1);
  assert.equal(failure.results[0].sourceId, `blocked-${suffix}`);
  assert.equal(failure.results[0].status, "error");
  const afterFailure = await getJson(`${base}/api/v1/state`);
  const failedJob = afterFailure.scheduler.jobs.find((job) => job.sourceId === `blocked-${suffix}`);
  assert.equal(failedJob.consecutiveFailures, 1);
  assert.match(failedJob.lastError, /Blocked private-network/);
  assert.ok(Date.parse(failedJob.nextRunAt) > Date.now());
});

test("source snapshot history keeps recent immutable snapshots with retention", async (t) => {
  const state = loadState();
  state.retention.snapshotHistoryLimit = 2;
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = Date.now().toString(36);
  const sourceId = `history-${suffix}`;

  const webhook = await postJson(`${base}/api/v1/sources`, {
    id: sourceId,
    connectorId: "webhook.json",
    name: "History webhook",
    config: { initialPayload: { value: 0 } }
  });

  for (const value of [1, 2, 3]) {
    const response = await fetch(`${base}${webhook.webhookUrl}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value })
    });
    assert.equal(response.status, 202);
  }

  const publicState = await getJson(`${base}/api/v1/state`);
  assert.equal(publicState.retention.snapshotHistoryLimit, 2);
  assert.equal(publicState.snapshots[sourceId].payload.value, 3);
  assert.deepEqual(publicState.snapshotHistory[sourceId].map((snapshot) => snapshot.payload.value), [3, 2]);

  const diagnostics = await getJson(`${base}/api/v1/diagnostics`);
  assert.equal(diagnostics.snapshotHistory[sourceId].length, 2);
  assert.equal(diagnostics.snapshotHistory[sourceId][0].payload, undefined);
  assert.equal(diagnostics.snapshotHistory[sourceId][0].payloadHash, publicState.snapshotHistory[sourceId][0].payloadHash);
});

test("device management supports policy presets, forced refresh, token rotation, and revocation", async (t) => {
  const state = await bootstrapState(loadState());
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const enrollment = await postJson(`${base}/api/v1/devices/enroll`, {
    name: "managed device",
    capabilities: { profileId: "kindle_basic_600x800" }
  });
  await postJson(`${base}/api/v1/devices/${enrollment.device.id}/assign`, { dashboardId: "system" });

  const first = await fetch(`${base}/api/v1/device/display`, {
    headers: { Authorization: `Bearer ${enrollment.token}` }
  });
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");

  await postJson(`${base}/api/v1/devices/${enrollment.device.id}/refresh-next-poll`, {});
  const queued = await getJson(`${base}/api/v1/state`);
  assert.equal(queued.deviceCommands[enrollment.device.id].forceRefresh, true);

  const forced = await fetch(`${base}/api/v1/device/display`, {
    headers: {
      Authorization: `Bearer ${enrollment.token}`,
      "If-None-Match": etag
    }
  });
  assert.equal(forced.status, 200);
  assert.equal(forced.headers.get("x-full-refresh"), "true");

  const unchanged = await fetch(`${base}/api/v1/device/display`, {
    headers: {
      Authorization: `Bearer ${enrollment.token}`,
      "If-None-Match": etag
    }
  });
  assert.equal(unchanged.status, 304);

  const policy = await patchJson(`${base}/api/v1/devices/${enrollment.device.id}/policy`, { preset: "battery_saver" });
  assert.equal(policy.pollPolicy.preset, "battery_saver");
  assert.equal(policy.pollPolicy.maxIntervalSeconds, 1800);

  const rotation = await postJson(`${base}/api/v1/devices/${enrollment.device.id}/rotate-token`, {});
  assert.ok(rotation.token);
  const oldToken = await fetch(`${base}/api/v1/device/display`, {
    headers: { Authorization: `Bearer ${enrollment.token}` }
  });
  assert.equal(oldToken.status, 401);
  const newToken = await fetch(`${base}/api/v1/device/display`, {
    headers: { Authorization: `Bearer ${rotation.token}` }
  });
  assert.equal(newToken.status, 200);

  const revoked = await postJson(`${base}/api/v1/devices/${enrollment.device.id}/revoke`, {});
  assert.ok(revoked.revokedAt);
  const revokedFetch = await fetch(`${base}/api/v1/device/display`, {
    headers: { Authorization: `Bearer ${rotation.token}` }
  });
  assert.equal(revokedFetch.status, 401);
});

test("dashboard management supports duplicate, archive, export, import, and safe delete", async (t) => {
  const state = await bootstrapState(loadState());
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = Date.now().toString(36);

  const duplicate = await postJson(`${base}/api/v1/dashboards/work/duplicate`, {
    id: `work-copy-${suffix}`,
    name: "Work Copy"
  });
  assert.equal(duplicate.dashboard.name, "Work Copy");
  assert.equal(duplicate.dashboard.archived, false);

  const archived = await postJson(`${base}/api/v1/dashboards/${duplicate.dashboard.id}/archive`, { archived: true });
  assert.equal(archived.archived, true);
  const restored = await postJson(`${base}/api/v1/dashboards/${duplicate.dashboard.id}/archive`, { archived: false });
  assert.equal(restored.archived, false);

  const exported = await getJson(`${base}/api/v1/dashboards/${duplicate.dashboard.id}/export`);
  assert.equal(exported.kind, "dashboard-kindle.dashboard");
  assert.equal(exported.dashboard.name, "Work Copy");

  const imported = await postJson(`${base}/api/v1/dashboards/import`, {
    id: `imported-${suffix}`,
    dashboard: exported.dashboard
  });
  assert.equal(imported.dashboard.id, `imported-${suffix}`);
  assert.equal(imported.dashboard.name, "Work Copy");

  const deleteAssigned = await fetch(`${base}/api/v1/dashboards/work`, {
    method: "DELETE",
    headers: adminHeaders
  });
  assert.equal(deleteAssigned.status, 409);

  const deleted = await deleteJson(`${base}/api/v1/dashboards/${duplicate.dashboard.id}`);
  assert.equal(deleted.deleted, true);
  const dashboards = await getJson(`${base}/api/v1/dashboards`);
  assert.equal(dashboards.some((dashboard) => dashboard.id === duplicate.dashboard.id), false);
  assert.equal(dashboards.some((dashboard) => dashboard.id === imported.dashboard.id), true);
});

test("weather, calendar, GitHub, Home Assistant, and authenticated HTTP source setup works without exposing secrets", async (t) => {
  const state = loadState();
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = Date.now().toString(36);

  const weather = await postJson(`${base}/api/v1/sources/test`, {
    connectorId: "weather.open-meteo",
    config: { mode: "fixture", locationName: "San Francisco", units: "imperial" }
  });
  assert.ok(weather.fields.some((field) => field.path === "$.current.temperatureF"));
  assert.ok(weather.fields.some((field) => field.path === "$.daily"));
  assert.ok(weather.fields.some((field) => field.path === "$.daily.0.highF"));

  const calendar = await postJson(`${base}/api/v1/sources/test`, {
    connectorId: "calendar.ics",
    config: { url: "fixture://calendar", maxEvents: 4 }
  });
  assert.ok(calendar.fields.some((field) => field.path === "$.events"));
  assert.equal(calendar.snapshot.payload.events[0].title, "Team standup");

  const githubTest = await postJson(`${base}/api/v1/sources/test`, {
    connectorId: "github.repo",
    config: { mode: "fixture", includeIssues: true, includePullRequests: true }
  });
  assert.ok(githubTest.fields.some((field) => field.path === "$.repository.stars"));
  assert.ok(githubTest.fields.some((field) => field.path === "$.issues"));
  assert.equal(githubTest.snapshot.payload.repository.fullName, "openai/dashboard-kindle-example");

  const githubId = `github-${suffix}`;
  const github = await postJson(`${base}/api/v1/sources`, {
    id: githubId,
    connectorId: "github.repo",
    name: "GitHub fixture with token",
    config: {
      mode: "fixture",
      token: "fake-token-for-redaction",
      includeIssues: true,
      includePullRequests: true
    }
  });
  assert.equal(github.source.config.token, "[REDACTED]");

  const homeAssistantTest = await postJson(`${base}/api/v1/sources/test`, {
    connectorId: "homeassistant.states",
    config: { mode: "fixture", maxEntities: 12 }
  });
  assert.ok(homeAssistantTest.fields.some((field) => field.path === "$.summary.unavailable"));
  assert.ok(homeAssistantTest.fields.some((field) => field.path === "$.entities"));
  assert.ok(homeAssistantTest.fields.some((field) => field.path === "$.entities.0.state"));
  assert.equal(homeAssistantTest.snapshot.payload.entities[0].entityId, "sensor.living_room_temperature");

  const homeAssistantId = `homeassistant-${suffix}`;
  const homeAssistant = await postJson(`${base}/api/v1/sources`, {
    id: homeAssistantId,
    connectorId: "homeassistant.states",
    name: "Home Assistant fixture with token",
    config: {
      mode: "fixture",
      token: "fake-home-assistant-token",
      maxEntities: 12
    }
  });
  assert.equal(homeAssistant.source.config.token, "[REDACTED]");

  const httpId = `auth-http-${suffix}`;
  const http = await postJson(`${base}/api/v1/sources`, {
    id: httpId,
    connectorId: "http.json",
    name: "Authenticated HTTP fixture",
    config: {
      url: "fixture://http",
      method: "GET",
      headers: { authorization: "Bearer test-secret" }
    }
  });
  assert.equal(http.source.config.headers.authorization, "[REDACTED]");

  const storedState = stateForStorage(state);
  assert.equal(storedState.connectorInstances[githubId].config.token.__encrypted, "dashboard-kindle.secret.v1");
  assert.equal(storedState.connectorInstances[homeAssistantId].config.token.__encrypted, "dashboard-kindle.secret.v1");
  assert.equal(storedState.connectorInstances[httpId].config.headers.authorization.__encrypted, "dashboard-kindle.secret.v1");
  assert.equal(JSON.stringify(storedState).includes("fake-token-for-redaction"), false);
  assert.equal(JSON.stringify(storedState).includes("fake-home-assistant-token"), false);
  assert.equal(JSON.stringify(storedState).includes("Bearer test-secret"), false);

  const runtimeState = structuredClone(storedState);
  decryptConnectorSecretsInPlace(runtimeState);
  assert.equal(runtimeState.connectorInstances[githubId].config.token, "fake-token-for-redaction");
  assert.equal(runtimeState.connectorInstances[homeAssistantId].config.token, "fake-home-assistant-token");
  assert.equal(runtimeState.connectorInstances[httpId].config.headers.authorization, "Bearer test-secret");

  const templates = await getJson(`${base}/api/v1/dashboard-templates`);
  assert.ok(templates.some((template) => template.id === "weather-clock"));
  assert.ok(templates.some((template) => template.id === "calendar-day"));
  assert.ok(templates.some((template) => template.id === "github-status"));
  assert.ok(templates.some((template) => template.id === "home-assistant-status"));
  const weatherDashboard = await postJson(`${base}/api/v1/dashboard-templates/weather-clock/clone`, {
    id: `weather-${suffix}`,
    name: "Weather test"
  });
  assert.equal(weatherDashboard.dashboard.name, "Weather test");
  const githubDashboard = await postJson(`${base}/api/v1/dashboard-templates/github-status/clone`, {
    id: `github-board-${suffix}`,
    name: "GitHub test"
  });
  assert.equal(githubDashboard.dashboard.name, "GitHub test");
  const homeAssistantDashboard = await postJson(`${base}/api/v1/dashboard-templates/home-assistant-status/clone`, {
    id: `home-assistant-board-${suffix}`,
    name: "Home Assistant test"
  });
  assert.equal(homeAssistantDashboard.dashboard.name, "Home Assistant test");
});

test("backup and restore scripts operate on state", async () => {
  const state = await bootstrapState(loadState());
  assert.ok(Object.keys(state.renderArtifacts).length >= 3);
  for (const artifact of Object.values(state.renderArtifacts)) {
    assert.equal(fs.existsSync(artifact.imagePath), true);
  }
});

test("backup API supports download, preview, and restore", async (t) => {
  const state = await bootstrapState(loadState());
  const server = createAppServer(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = Date.now().toString(36);

  const created = await postJson(`${base}/api/v1/backups`, {});
  assert.match(created.backup.fileName, /^dashboard-kindle-.+\.json$/);
  assert.ok(created.backup.bytes > 0);

  const download = await fetch(`${base}${created.backup.downloadUrl}`, { headers: adminHeaders });
  assert.equal(download.status, 200);
  const backup = JSON.parse(await download.text());
  assert.equal(backup.kind, "dashboard-kindle.backup");
  assert.ok(backup.state.dashboards.work);

  const preview = await postJson(`${base}/api/v1/backups/preview`, { backup });
  assert.equal(preview.valid, true);
  assert.equal(preview.summary.dashboards, Object.keys(backup.state.dashboards).length);

  const temporary = await postJson(`${base}/api/v1/dashboard-templates/clock-status/clone`, {
    id: `temporary-${suffix}`,
    name: "Temporary dashboard"
  });
  assert.equal(temporary.dashboard.name, "Temporary dashboard");
  const withTemporary = await getJson(`${base}/api/v1/dashboards`);
  assert.equal(withTemporary.some((dashboard) => dashboard.id === `temporary-${suffix}`), true);

  const restored = await postJson(`${base}/api/v1/backups/restore`, { backup });
  assert.equal(restored.valid, true);
  const dashboards = await getJson(`${base}/api/v1/dashboards`);
  assert.equal(dashboards.some((dashboard) => dashboard.id === `temporary-${suffix}`), false);
  assert.equal(dashboards.some((dashboard) => dashboard.id === "work"), true);
});

test("render artifact retention removes old files while preserving current device artifacts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-artifacts-"));
  const state = loadState();
  state.retention.renderArtifactLimitPerDashboard = 2;
  state.renderArtifacts = {};
  state.deviceCheckins = { device1: { currentArtifactId: "artifact-old-protected" } };

  for (const [index, id] of ["artifact-new", "artifact-mid", "artifact-old-remove", "artifact-old-protected"].entries()) {
    const artifactDir = path.join(tempDir, id);
    fs.mkdirSync(artifactDir, { recursive: true });
    const imagePath = path.join(artifactDir, `${id}.png`);
    const svgPath = path.join(artifactDir, `${id}.svg`);
    const pgmPath = path.join(artifactDir, `${id}.pgm`);
    fs.writeFileSync(imagePath, id);
    fs.writeFileSync(svgPath, id);
    fs.writeFileSync(pgmPath, id);
    state.renderArtifacts[id] = {
      id,
      dashboardId: "work",
      imagePath,
      svgPath,
      pgmPath,
      createdAt: new Date(Date.parse("2026-07-13T12:00:00.000Z") - index * 60_000).toISOString()
    };
  }

  const result = cleanupRenderArtifacts(state);
  assert.deepEqual(result.artifactIds, ["artifact-old-remove"]);
  assert.equal(state.renderArtifacts["artifact-new"] !== undefined, true);
  assert.equal(state.renderArtifacts["artifact-mid"] !== undefined, true);
  assert.equal(state.renderArtifacts["artifact-old-protected"] !== undefined, true);
  assert.equal(state.renderArtifacts["artifact-old-remove"], undefined);
  assert.equal(fs.existsSync(path.join(tempDir, "artifact-old-remove", "artifact-old-remove.png")), false);
  assert.equal(fs.existsSync(path.join(tempDir, "artifact-old-protected", "artifact-old-protected.png")), true);
});

test("backup script prunes older backups according to retention policy", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-backups-"));
  const backupDir = path.join(tempDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, "state.json"), JSON.stringify({ retention: { backupLimit: 2 }, marker: "current" }));
  for (const [index, name] of ["dashboard-kindle-old-a.json", "dashboard-kindle-old-b.json", "dashboard-kindle-old-c.json"].entries()) {
    const filePath = path.join(backupDir, name);
    fs.writeFileSync(filePath, "{}\n");
    const mtime = new Date(Date.parse("2026-07-13T12:00:00.000Z") + index * 1000);
    fs.utimesSync(filePath, mtime, mtime);
  }

  const result = spawnSync(process.execPath, ["scripts/backup.js"], {
    cwd: process.cwd(),
    env: { ...process.env, DASHBOARD_KINDLE_DATA_DIR: tempDir, DASHBOARD_KINDLE_BACKUP_LIMIT: "2" },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const remaining = fs.readdirSync(backupDir).filter((name) => name.endsWith(".json")).sort();
  assert.equal(remaining.length, 2);
  assert.equal(remaining.some((name) => name.startsWith("dashboard-kindle-old-a")), false);
  assert.equal(remaining.some((name) => name.startsWith("dashboard-kindle-20")), true);
});

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function deleteJson(url) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: adminHeaders
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url, { headers: adminHeaders });
  if (!response.ok) {
    assert.fail(`${response.status} ${await response.text()}`);
  }
  return response.json();
}
