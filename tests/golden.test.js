import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bootstrapState, loadState } from "../apps/server/src/main.js";

test("golden render artifacts are produced for representative dashboards", async () => {
  const state = await bootstrapState(loadState());
  const artifacts = Object.values(state.renderArtifacts);
  const dashboardIds = new Set(artifacts.map((artifact) => artifact.dashboardId));
  assert.ok(dashboardIds.has("work"));
  assert.ok(dashboardIds.has("system"));
  assert.ok(dashboardIds.has("minimal"));
  for (const artifact of artifacts) {
    assert.ok(artifact.bytes > 1000, `${artifact.id} should be a non-empty image`);
    assert.equal(fs.existsSync(artifact.imagePath), true);
    assert.equal(fs.existsSync(artifact.pgmPath), true);
  }
});
