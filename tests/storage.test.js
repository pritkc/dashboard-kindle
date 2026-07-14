import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadStoredState, migrateStateStorage, saveStoredState, storagePaths } from "../packages/storage/src/sqlite-state.js";
import { writeJson } from "../packages/domain/src/core.js";

test("SQLite storage saves and loads canonical state transactionally", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-storage-"));
  const state = { schemaVersion: 1, marker: "sqlite", nested: { value: 42 } };

  saveStoredState(dataDir, state);
  assert.deepEqual(loadStoredState(dataDir), state);

  const paths = storagePaths(dataDir);
  assert.equal(fs.existsSync(paths.sqlitePath), true);
  const db = new DatabaseSync(paths.sqlitePath);
  try {
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version = 1").get().name, "canonical_json_state");
  } finally {
    db.close();
  }
});

test("migration imports legacy state.json once and creates a timestamped backup", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-storage-"));
  const paths = storagePaths(dataDir);
  const legacyState = { schemaVersion: 1, marker: "legacy-json" };
  writeJson(paths.legacyJsonPath, legacyState);

  const info = migrateStateStorage(dataDir);
  assert.equal(info.kind, "sqlite");
  assert.equal(info.legacyJsonExists, true);
  assert.deepEqual(loadStoredState(dataDir), legacyState);

  const importBackups = fs.readdirSync(paths.backupDir).filter((name) => /^state-json-import-.+\.backup$/.test(name));
  assert.equal(importBackups.length, 1);

  saveStoredState(dataDir, { schemaVersion: 1, marker: "new-sqlite" });
  writeJson(paths.legacyJsonPath, { schemaVersion: 1, marker: "ignored-later" });
  migrateStateStorage(dataDir);
  assert.equal(loadStoredState(dataDir).marker, "new-sqlite");
  assert.equal(fs.readdirSync(paths.backupDir).filter((name) => /^state-json-import-.+\.backup$/.test(name)).length, 1);
});
