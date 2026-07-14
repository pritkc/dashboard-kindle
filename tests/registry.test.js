import test from "node:test";
import assert from "node:assert/strict";
import { defaultState } from "../packages/domain/src/core.js";
import { connectorCollectors } from "../packages/connectors-built-in/src/connectors.js";
import { widgetRenderers, widgetTypes } from "../packages/renderer/src/render.js";

test("built-in connector registry covers every connector manifest", () => {
  const state = defaultState();
  for (const connectorId of Object.keys(state.connectorManifests)) {
    assert.equal(typeof connectorCollectors[connectorId], "function", `${connectorId} should have a collector`);
  }
});

test("widget registry exposes every public widget type", () => {
  assert.deepEqual([...widgetTypes].sort(), Object.keys(widgetRenderers).sort());
  for (const type of ["text", "metric", "progress", "status", "list", "bars", "clock", "alert"]) {
    assert.equal(typeof widgetRenderers[type], "function", `${type} should have a renderer`);
  }
});
