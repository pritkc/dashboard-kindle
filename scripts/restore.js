import fs from "node:fs";
import path from "node:path";
import { repoPath } from "../packages/domain/src/core.js";
import { saveStoredState, storagePaths } from "../packages/storage/src/sqlite-state.js";

const input = process.argv[2];
if (!input) throw new Error("Usage: pnpm restore <backup-json>");
const backup = JSON.parse(fs.readFileSync(input, "utf8"));
const dataDir = path.resolve(process.env.DASHBOARD_KINDLE_DATA_DIR ?? repoPath("data"));
saveStoredState(dataDir, backup.state ?? backup);
console.log(`Restored ${storagePaths(dataDir).sqlitePath}`);
