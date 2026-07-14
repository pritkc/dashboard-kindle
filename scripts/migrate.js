import path from "node:path";
import { repoPath } from "../packages/domain/src/core.js";
import { migrateStateStorage } from "../packages/storage/src/sqlite-state.js";

const dataDir = path.resolve(process.env.DASHBOARD_KINDLE_DATA_DIR ?? repoPath("data"));
const info = migrateStateStorage(dataDir);
console.log(JSON.stringify({
  status: "ok",
  kind: info.kind,
  path: info.path,
  bytes: info.bytes,
  walPath: info.walPath,
  walBytes: info.walBytes,
  legacyJsonImported: info.legacyJsonExists
}, null, 2));
