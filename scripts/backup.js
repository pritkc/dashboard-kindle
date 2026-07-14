import fs from "node:fs";
import path from "node:path";
import { repoPath } from "../packages/domain/src/core.js";

const dataDir = path.resolve(process.env.DASHBOARD_KINDLE_DATA_DIR ?? repoPath("data"));
const backupDir = path.join(dataDir, "backups");
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(backupDir, `dashboard-kindle-${stamp}.json`);
const statePath = path.join(dataDir, "state.json");
if (!fs.existsSync(statePath)) throw new Error("No state.json exists. Run pnpm seed first.");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const backup = {
  createdAt: new Date().toISOString(),
  state
};
fs.writeFileSync(target, `${JSON.stringify(backup, null, 2)}\n`);
cleanupBackups(backupDir, state);
console.log(target);

function cleanupBackups(directory, state) {
  const limit = normalizedBackupLimit(state);
  const backups = fs.readdirSync(directory)
    .filter((name) => /^dashboard-kindle-.+\.json$/.test(name))
    .map((name) => {
      const filePath = path.join(directory, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const backup of backups.slice(limit)) fs.unlinkSync(backup.filePath);
}

function normalizedBackupLimit(state) {
  const requested = Number(process.env.DASHBOARD_KINDLE_BACKUP_LIMIT ?? state?.retention?.backupLimit ?? 10);
  if (!Number.isFinite(requested) || requested < 1) return 10;
  return Math.min(1000, Math.round(requested));
}
