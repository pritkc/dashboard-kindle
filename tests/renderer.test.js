import test from "node:test";
import assert from "node:assert/strict";
import { createDashboardRevision, createSnapshot, hashPayload } from "../packages/domain/src/core.js";
import { renderDashboardDiagnostics, renderDashboardSvg } from "../packages/renderer/src/render.js";

test("renderer clips widgets to safe-area bounds when enabled", () => {
  const definition = {
    name: "Safe area",
    layout: { useSafeArea: true },
    profile: { width: 200, height: 160, safeArea: { top: 10, right: 20, bottom: 30, left: 40 } },
    widgets: [
      { id: "edge", type: "text", sourceId: "manual", expression: "$.message", x: 0, y: 0, w: 220, h: 180 }
    ]
  };
  const snapshots = { manual: snapshot("manual", { message: "inside safe area" }) };

  const svg = renderDashboardSvg(definition, snapshots);
  const diagnostics = renderDashboardDiagnostics(definition, snapshots);

  assert.match(svg, /<clipPath id="widget-clip-edge"><rect x="40" y="10" width="140" height="120"/);
  assert.equal(diagnostics.some((item) => item.widgetId === "edge" && item.code === "widget-clipped"), true);
});

test("renderer exposes missing and error source states visibly", () => {
  const definition = {
    name: "States",
    profile: { width: 400, height: 240 },
    widgets: [
      { id: "missing", type: "metric", sourceId: "missing-source", x: 0, y: 0, w: 180, h: 110 },
      { id: "error", type: "status", sourceId: "broken", x: 190, y: 0, w: 190, h: 110 }
    ]
  };
  const snapshots = {
    broken: {
      sourceId: "broken",
      payloadHash: hashPayload({}),
      state: "error",
      diagnostics: { error: "Connector timed out" }
    }
  };

  const svg = renderDashboardSvg(definition, snapshots);

  assert.match(svg, /missing/);
  assert.match(svg, /Missing/);
  assert.match(svg, /source data/);
  assert.match(svg, /error/);
  assert.match(svg, /Connector/);
  assert.match(svg, /timed out/);
});

test("renderer supports profile rotation and truncates long text", () => {
  const definition = {
    name: "Rotation",
    profile: { width: 320, height: 240 },
    widgets: [
      { id: "long", type: "text", sourceId: "manual", expression: "$.message", x: 0, y: 0, w: 180, h: 95 }
    ]
  };
  const snapshots = { manual: snapshot("manual", { message: "Supercalifragilisticexpialidocious words continue beyond the available space" }) };

  const svg = renderDashboardSvg(definition, snapshots, { rotationDegrees: 180 });

  assert.match(svg, /transform="rotate\(180 160 120\)"/);
  assert.match(svg, /\.\.\./);
  assert.doesNotMatch(svg, /Supercalifragilisticexpialidocious words continue beyond/);
});

test("renderer keeps normal dashboards free of clipping diagnostics", () => {
  const dashboard = {
    id: "normal",
    name: "Normal",
    draft: {
      name: "Normal",
      profile: { width: 320, height: 240 },
      widgets: [
        { id: "metric", type: "metric", sourceId: "manual", expression: "$.value", x: 10, y: 10, w: 200, h: 100 }
      ]
    }
  };
  createDashboardRevision(dashboard, dashboard.draft);
  const diagnostics = renderDashboardDiagnostics(dashboard.draft, { manual: snapshot("manual", { value: 12 }) });
  assert.deepEqual(diagnostics, []);
});

function snapshot(sourceId, payload) {
  return createSnapshot({ id: sourceId, connectorId: "static.manual" }, payload, {
    observedAt: "2026-07-13T12:00:00.000Z"
  });
}
