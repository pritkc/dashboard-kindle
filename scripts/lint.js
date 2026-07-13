import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repoPath } from "../packages/domain/src/core.js";

const roots = ["apps", "packages", "clients", "scripts", "tests"];
const files = [];
for (const root of roots) walk(repoPath(root), files);
for (const file of files.filter((item) => item.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status);
  const text = fs.readFileSync(file, "utf8");
  if (/\t/.test(text)) throw new Error(`Tabs are not used in source files: ${file}`);
}
console.log(`Lint syntax check passed for ${files.filter((item) => item.endsWith(".js")).length} JavaScript files.`);

function walk(dir, output) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else output.push(full);
  }
}
