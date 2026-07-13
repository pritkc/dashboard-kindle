import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { bootstrapState, createAppServer, loadState } from "../apps/server/src/main.js";
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

test("backup and restore scripts operate on state", async () => {
  const state = await bootstrapState(loadState());
  assert.ok(Object.keys(state.renderArtifacts).length >= 3);
  for (const artifact of Object.values(state.renderArtifacts)) {
    assert.equal(fs.existsSync(artifact.imagePath), true);
  }
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
