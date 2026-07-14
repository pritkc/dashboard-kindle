import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repoPath } from "../packages/domain/src/core.js";

const roots = ["apps", "packages", "clients", "scripts", "tests"];
const files = roots.flatMap((root) => walk(repoPath(root))).filter((file) => file.endsWith(".js"));

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status);
}

console.log(`Static JavaScript syntax check passed for ${files.length} files.`);

function walk(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else output.push(full);
  }
  return output;
}
