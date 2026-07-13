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
const backup = {
  createdAt: new Date().toISOString(),
  state: JSON.parse(fs.readFileSync(statePath, "utf8"))
};
fs.writeFileSync(target, `${JSON.stringify(backup, null, 2)}\n`);
console.log(target);
