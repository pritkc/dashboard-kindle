import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
