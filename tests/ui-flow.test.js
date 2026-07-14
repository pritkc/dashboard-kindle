import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { repoPath } from "../packages/domain/src/core.js";

const html = fs.readFileSync(repoPath("apps/server/public/index.html"), "utf8");
const app = fs.readFileSync(repoPath("apps/server/public/app.js"), "utf8");

test("control-plane HTML exposes required no-code flow controls", () => {
  for (const id of [
    "loginForm",
    "adminToken",
    "setupChecklist",
    "sourceConnector",
    "sourceConfigForm",
    "testSource",
    "saveSource",
    "sourceFields",
    "dashboardSelect",
    "widgetSelect",
    "applyWidget",
    "publish",
    "render",
    "processedPreview",
    "pairDeviceProfile",
    "pairCompatibility",
    "createPairing",
    "managedDeviceSelect",
    "saveDevicePolicy",
    "createBackup",
    "previewBackup",
    "restoreBackup",
    "refreshDiagnostics",
    "exportDiagnostics"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should be present in index.html`);
  }
});

test("control-plane JavaScript wires browser-flow interactions", () => {
  for (const [id, handler] of [
    ["loginForm", "withAction"],
    ["testSource", "testSource"],
    ["saveSource", "saveSource"],
    ["publish", "publish"],
    ["render", "renderCurrent"],
    ["createPairing", "createPairing"],
    ["saveDevicePolicy", "saveDevicePolicy"],
    ["createBackup", "createBackupAction"],
    ["previewBackup", "previewBackupAction"],
    ["restoreBackup", "restoreBackupAction"],
    ["refreshDiagnostics", "refreshDiagnosticsAction"],
    ["applyWidget", "withAction"]
  ]) {
    const listenerIndex = app.indexOf(`$("${id}").addEventListener`);
    assert.notEqual(listenerIndex, -1, `${id} should have an event listener`);
    assert.notEqual(app.slice(listenerIndex, listenerIndex + 220).indexOf(handler), -1, `${id} listener should wire ${handler}`);
  }
});

test("control-plane render loop includes setup, source, dashboard, device, backup, and diagnostics panels", () => {
  for (const functionName of [
    "renderSetup",
    "renderDiagnostics",
    "renderBackupRestore",
    "renderSources",
    "renderSourceWizard",
    "renderDashboardManagement",
    "renderWidgetBuilder",
    "renderDevices",
    "renderDeviceManagement"
  ]) {
    assert.match(app, new RegExp(`${functionName}\\(\\);`), `${functionName} should be called by render()`);
  }
});
