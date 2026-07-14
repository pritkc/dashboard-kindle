import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectConnector } from "../packages/connectors-built-in/src/connectors.js";
import { createDashboardRevision, defaultState, repoPath } from "../packages/domain/src/core.js";
import { writeRenderArtifact } from "../packages/renderer/src/render.js";

const renderNow = "2026-07-13T12:34:00.000Z";
const approvedDir = repoPath("tests/golden/approved");
const updateGolden = process.env.UPDATE_GOLDEN === "1";
const cases = [
  { id: "work-default", dashboardId: "work", profile: {} },
  { id: "minimal-kindle-basic", dashboardId: "minimal", profile: { profileId: "kindle_basic_600x800" } },
  { id: "system-paperwhite", dashboardId: "system", profile: { profileId: "kindle_pw_758x1024" } }
];

test("golden render artifacts match approved pixel references", async () => {
  const previousRenderNow = process.env.DASHBOARD_KINDLE_RENDER_NOW;
  process.env.DASHBOARD_KINDLE_RENDER_NOW = renderNow;
  try {
    const state = defaultState();
    const snapshots = {};
    for (const instance of Object.values(state.connectorInstances)) {
      snapshots[instance.id] = await collectConnector(instance, { observedAt: renderNow });
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-golden-"));
    if (updateGolden) fs.mkdirSync(approvedDir, { recursive: true });

    for (const item of cases) {
      const dashboard = state.dashboards[item.dashboardId];
      const revision = createDashboardRevision(dashboard, dashboard.draft);
      const relevantSnapshots = snapshotsForDefinition(dashboard.draft, snapshots);
      const artifact = writeRenderArtifact({
        artifactId: `golden-${item.id}`,
        definition: dashboard.draft,
        revision,
        snapshots: relevantSnapshots,
        profile: item.profile,
        dataDir
      });
      assert.ok(artifact.bytes > 1000, `${item.id} should render a non-empty PNG`);
      const actualPath = artifact.pgmPath;
      const approvedPath = path.join(approvedDir, `${item.id}.pgm`);
      if (updateGolden) {
        fs.copyFileSync(actualPath, approvedPath);
        continue;
      }
      assert.equal(fs.existsSync(approvedPath), true, `Missing approved golden image ${approvedPath}. Run UPDATE_GOLDEN=1 pnpm test:golden after reviewing renderer changes.`);
      const comparison = comparePgm(approvedPath, actualPath);
      if (!comparison.passed) {
        const diffPath = path.join(os.tmpdir(), `dashboard-kindle-${item.id}-diff.pgm`);
        writeDiffPgm(diffPath, comparison);
        assert.fail(`${item.id} differs from approved golden: ${comparison.differentPixels}/${comparison.totalPixels} pixels changed, max delta ${comparison.maxDelta}, mean delta ${comparison.meanDelta.toFixed(4)}. Diff written to ${diffPath}`);
      }
    }
  } finally {
    if (previousRenderNow === undefined) delete process.env.DASHBOARD_KINDLE_RENDER_NOW;
    else process.env.DASHBOARD_KINDLE_RENDER_NOW = previousRenderNow;
  }
});

function snapshotsForDefinition(definition, snapshots) {
  const sourceIds = [...new Set(definition.widgets.map((widget) => widget.sourceId).filter(Boolean))];
  return Object.fromEntries(sourceIds.map((sourceId) => [sourceId, snapshots[sourceId]]));
}

function comparePgm(expectedPath, actualPath) {
  const expected = readPgm(expectedPath);
  const actual = readPgm(actualPath);
  assert.equal(actual.width, expected.width, "golden width changed");
  assert.equal(actual.height, expected.height, "golden height changed");
  assert.equal(actual.max, expected.max, "golden max value changed");
  let differentPixels = 0;
  let maxDelta = 0;
  let totalDelta = 0;
  const diff = new Uint8Array(actual.pixels.length);
  for (let index = 0; index < actual.pixels.length; index += 1) {
    const delta = Math.abs(actual.pixels[index] - expected.pixels[index]);
    if (delta > 0) differentPixels += 1;
    if (delta > maxDelta) maxDelta = delta;
    totalDelta += delta;
    diff[index] = delta;
  }
  const totalPixels = actual.pixels.length;
  const changedRatio = differentPixels / totalPixels;
  const meanDelta = totalDelta / totalPixels;
  return {
    passed: changedRatio <= 0.0025 && meanDelta <= 0.15 && maxDelta <= 96,
    width: actual.width,
    height: actual.height,
    max: actual.max,
    diff,
    totalPixels,
    differentPixels,
    changedRatio,
    maxDelta,
    meanDelta
  };
}

function readPgm(filePath) {
  const tokens = fs.readFileSync(filePath, "utf8")
    .replace(/#[^\n\r]*/g, " ")
    .trim()
    .split(/\s+/);
  const magic = tokens.shift();
  if (magic !== "P2") throw new Error(`Only plain PGM P2 files are supported for golden tests: ${filePath}`);
  const width = Number(tokens.shift());
  const height = Number(tokens.shift());
  const max = Number(tokens.shift());
  const pixels = Uint16Array.from(tokens.map(Number));
  assert.equal(pixels.length, width * height, `PGM pixel count mismatch for ${filePath}`);
  return { width, height, max, pixels };
}

function writeDiffPgm(filePath, comparison) {
  const scale = comparison.maxDelta > 0 ? 255 / comparison.maxDelta : 1;
  const values = [...comparison.diff].map((value) => Math.min(255, Math.round(value * scale)));
  const lines = [`P2`, `${comparison.width} ${comparison.height}`, "255"];
  for (let index = 0; index < values.length; index += 24) {
    lines.push(values.slice(index, index + 24).join(" "));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}
