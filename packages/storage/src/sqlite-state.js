import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso, readJson, writeJson } from "../../domain/src/core.js";

const migrationVersion = 1;

export function storagePaths(dataDir) {
  return {
    dataDir,
    sqlitePath: path.join(dataDir, "dashboard-kindle.sqlite"),
    legacyJsonPath: path.join(dataDir, "state.json"),
    backupDir: path.join(dataDir, "backups")
  };
}

export function loadStoredState(dataDir) {
  const paths = storagePaths(dataDir);
  const db = openStateDatabase(paths);
  try {
    importLegacyJsonIfNeeded(db, paths);
    const row = db.prepare("SELECT state_json FROM app_state WHERE id = ?").get("default");
    return row ? JSON.parse(row.state_json) : null;
  } finally {
    db.close();
  }
}

export function saveStoredState(dataDir, state) {
  const paths = storagePaths(dataDir);
  const db = openStateDatabase(paths);
  try {
    saveStateTransaction(db, state);
  } finally {
    db.close();
  }
}

export function migrateStateStorage(dataDir) {
  const paths = storagePaths(dataDir);
  const db = openStateDatabase(paths);
  try {
    importLegacyJsonIfNeeded(db, paths);
    return stateStorageInfo(dataDir);
  } finally {
    db.close();
  }
}

export function stateStorageInfo(dataDir) {
  const paths = storagePaths(dataDir);
  const exists = fs.existsSync(paths.sqlitePath);
  return {
    kind: "sqlite",
    persistent: exists,
    path: paths.sqlitePath,
    bytes: exists ? fs.statSync(paths.sqlitePath).size : 0,
    walPath: `${paths.sqlitePath}-wal`,
    walBytes: fs.existsSync(`${paths.sqlitePath}-wal`) ? fs.statSync(`${paths.sqlitePath}-wal`).size : 0,
    legacyJsonPath: paths.legacyJsonPath,
    legacyJsonExists: fs.existsSync(paths.legacyJsonPath)
  };
}

function openStateDatabase(paths) {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const db = new DatabaseSync(paths.sqlitePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
    migrationVersion,
    "canonical_json_state",
    nowIso()
  );
  return db;
}

function importLegacyJsonIfNeeded(db, paths) {
  const existing = db.prepare("SELECT 1 FROM app_state WHERE id = ?").get("default");
  if (existing || !fs.existsSync(paths.legacyJsonPath)) return;
  const state = readJson(paths.legacyJsonPath, null);
  if (!state) return;
  fs.mkdirSync(paths.backupDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const backupPath = path.join(paths.backupDir, `state-json-import-${stamp}.backup`);
  writeJson(backupPath, state);
  saveStateTransaction(db, state);
}

function saveStateTransaction(db, state) {
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      INSERT INTO app_state (id, state_json, updated_at)
      VALUES ('default', ?, ?)
      ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(state), nowIso());
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may not have opened.
    }
    throw error;
  }
}
