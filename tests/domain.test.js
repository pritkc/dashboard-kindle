import test from "node:test";
import assert from "node:assert/strict";
import { computeNextPollSeconds, defaultState, hashPayload, isPrivateNetworkUrl, quietHourBoundary, stableStringify } from "../packages/domain/src/core.js";
import { calculateWakeDecision } from "../packages/scheduling/src/scheduling.js";
import { thresholdPixel, quantizeGray, bayerThreshold } from "../packages/eink-processing/src/dither.js";
import { resolveProfile } from "../packages/device-profiles/src/profiles.js";

test("stable hashing is deterministic across object key order", () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
  assert.equal(hashPayload({ b: 2, a: 1 }), hashPayload({ a: 1, b: 2 }));
});

test("SSRF guard blocks private targets by default", () => {
  assert.equal(isPrivateNetworkUrl("http://127.0.0.1:5600/api/0/buckets"), true);
  assert.equal(isPrivateNetworkUrl("http://169.254.169.254/latest/meta-data"), true);
  assert.equal(isPrivateNetworkUrl("https://example.com/data.json"), false);
});

test("quiet hours crossing midnight calculate next boundary", () => {
  const now = new Date("2026-07-13T06:30:00.000Z");
  const boundary = quietHourBoundary(now, { enabled: true, start: "22:00", end: "06:00" }, "UTC");
  assert.equal(new Date(boundary).toISOString(), "2026-07-13T22:00:00.000Z");
  const late = new Date("2026-07-13T23:30:00.000Z");
  const lateBoundary = quietHourBoundary(late, { enabled: true, start: "22:00", end: "06:00" }, "UTC");
  assert.equal(new Date(lateBoundary).toISOString(), "2026-07-14T06:00:00.000Z");
});

test("poll calculation uses the nearest useful boundary within limits", () => {
  const nowMs = Date.parse("2026-07-13T12:00:00.000Z");
  assert.equal(computeNextPollSeconds({ minIntervalSeconds: 30, maxIntervalSeconds: 300 }, {
    nowMs,
    nextPlaylistTransitionMs: nowMs + 120_000,
    nextClockBoundaryMs: nowMs + 60_000,
    sourceValidityDeadlineMs: nowMs + 240_000
  }), 60);
});

test("wake decision emits full refresh on configured count", () => {
  const decision = calculateWakeDecision({ minIntervalSeconds: 30, maxIntervalSeconds: 300, fullRefreshInterval: 3 }, {
    nowMs: Date.parse("2026-07-13T12:00:00.000Z"),
    nextClockBoundaryMs: Date.parse("2026-07-13T12:01:00.000Z"),
    changeCount: 6
  });
  assert.equal(decision.nextPollSeconds, 60);
  assert.equal(decision.fullRefresh, true);
});

test("dithering helpers quantize grayscale values", () => {
  assert.equal(thresholdPixel(10), 0);
  assert.equal(thresholdPixel(200), 255);
  assert.equal(quantizeGray(120, 4), 85);
  assert.equal(Number.isFinite(bayerThreshold(3, 2, 4)), true);
});

test("default state includes required sample dashboards and sources", () => {
  const state = defaultState();
  assert.deepEqual(Object.keys(state.dashboards).sort(), ["minimal", "system", "work"]);
  assert.ok(state.connectorInstances.codexbar);
  assert.ok(state.connectorInstances.activitywatch);
});

test("device profile resolution is idempotent when passed an already resolved profile", () => {
  const first = resolveProfile({ profileId: "kindle_basic_600x800" });
  const second = resolveProfile(first, first);
  assert.equal(second.hash, first.hash);
});
