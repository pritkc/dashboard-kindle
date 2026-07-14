import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleDisplayResponse, runSimulatorOnce, simulatorConfigFromEnv, validatePng } from "../clients/simulator/src/client.js";
import { sha256 } from "../packages/domain/src/core.js";

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82
]);

test("simulator stores valid PNGs and persists ETag metadata atomically", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-sim-"));
  const etagPath = path.join(outputDir, "etag.txt");
  const response = responseFor(200, pngBytes, {
    "content-type": "image/png",
    "x-image-sha256": sha256(pngBytes),
    etag: "\"abc\"",
    "x-next-poll-seconds": "60",
    "x-full-refresh": "true",
    "x-render-id": "render-1"
  });

  const result = await handleDisplayResponse(response, {
    outputDir,
    etagPath,
    capabilities: { profileId: "custom", width: 480, height: 320 }
  });

  assert.equal(result.status, "stored");
  assert.equal(result.hash, sha256(pngBytes));
  assert.equal(result.nextPollSeconds, 60);
  assert.equal(result.fullRefresh, true);
  assert.equal(fs.readFileSync(etagPath, "utf8"), "\"abc\"");
  assert.equal(fs.existsSync(path.join(outputDir, `${sha256(pngBytes)}.png`)), true);
  const latest = JSON.parse(fs.readFileSync(path.join(outputDir, "latest.json"), "utf8"));
  assert.deepEqual(latest.capabilities, { profileId: "custom", width: 480, height: 320 });
});

test("simulator keeps unchanged display state on 304", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-sim-"));
  const etagPath = path.join(outputDir, "etag.txt");
  fs.writeFileSync(etagPath, "\"old\"");
  const result = await handleDisplayResponse(notModifiedResponse({
    etag: "\"new\"",
    "x-next-poll-seconds": "300"
  }), { outputDir, etagPath });

  assert.equal(result.status, "unchanged");
  assert.equal(result.nextPollSeconds, 300);
  assert.equal(fs.readFileSync(etagPath, "utf8"), "\"new\"");
});

test("simulator rejects invalid token, wrong content type, wrong hash, and truncated PNG", async () => {
  await assert.rejects(
    () => handleDisplayResponse(responseFor(401, "bad token", { "content-type": "text/plain" }), { outputDir: os.tmpdir(), etagPath: path.join(os.tmpdir(), "none") }),
    /Display fetch failed: 401/
  );
  await assert.rejects(
    () => handleDisplayResponse(responseFor(200, "{}", { "content-type": "application/json", "x-image-sha256": sha256("{}") }), { outputDir: os.tmpdir(), etagPath: path.join(os.tmpdir(), "none") }),
    /Unexpected content type/
  );
  await assert.rejects(
    () => handleDisplayResponse(responseFor(200, pngBytes, { "content-type": "image/png", "x-image-sha256": "wrong" }), { outputDir: os.tmpdir(), etagPath: path.join(os.tmpdir(), "none") }),
    /Hash mismatch/
  );
  assert.throws(() => validatePng(pngBytes.subarray(0, 16)), /Truncated PNG download/);
});

test("simulator retries offline display fetches with backoff", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-sim-"));
  const delays = [];
  let attempts = 0;
  const result = await runSimulatorOnce({
    server: "http://offline.test",
    token: "device-token",
    outputDir,
    maxAttempts: 3,
    baseBackoffMs: 10,
    sleep: async (ms) => delays.push(ms),
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("connect ECONNREFUSED");
    }
  });

  assert.equal(result.status, "offline");
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.match(result.error, /ECONNREFUSED/);
});

test("simulator enrollment reports custom capabilities from environment", async () => {
  const config = simulatorConfigFromEnv({
    DASHBOARD_KINDLE_SERVER: "http://server.test",
    DASHBOARD_KINDLE_ADMIN_TOKEN: "admin",
    DASHBOARD_KINDLE_PROFILE_ID: "custom",
    DASHBOARD_KINDLE_DEVICE_WIDTH: "1024",
    DASHBOARD_KINDLE_DEVICE_HEIGHT: "768",
    DASHBOARD_KINDLE_SIMULATOR_ATTEMPTS: "1"
  });
  let enrollmentBody;
  const result = await runSimulatorOnce({
    ...config,
    outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-sim-")),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/v1/devices/enroll")) {
        enrollmentBody = JSON.parse(options.body);
        return jsonResponse(201, { token: "enrolled-token", device: { id: "device-1" } });
      }
      assert.equal(options.headers.Authorization, "Bearer enrolled-token");
      return notModifiedResponse({ "x-next-poll-seconds": "120" });
    }
  });

  assert.deepEqual(enrollmentBody.capabilities, { profileId: "custom", width: 1024, height: 768 });
  assert.equal(result.status, "unchanged");
  assert.equal(result.nextPollSeconds, 120);
});

function responseFor(status, body, headers = {}) {
  return new Response(body, { status, headers });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function notModifiedResponse(headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status: 304,
    ok: false,
    headers: {
      get(key) {
        return map.get(key.toLowerCase()) ?? null;
      }
    },
    async text() {
      return "";
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    }
  };
}
