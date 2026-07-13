import fs from "node:fs";
import path from "node:path";
import { repoPath } from "../packages/domain/src/core.js";

const required = [
  "apps/server/src/main.js",
  "apps/server/public/index.html",
  "clients/kindle-kual/dashboard-kindle/menu.json",
  "clients/kindle-kual/dashboard-kindle/bin/dashboard-kindle.sh",
  "clients/simulator/src/main.js",
  "Dockerfile",
  "docker-compose.yml",
  ".github/workflows/ci.yml"
];

for (const file of required) {
  const absolute = repoPath(file);
  if (!fs.existsSync(absolute)) throw new Error(`Missing build artifact: ${file}`);
}

const packageDir = repoPath("data/artifacts/dashboard-kindle-kual");
fs.mkdirSync(packageDir, { recursive: true });
fs.cpSync(repoPath("clients/kindle-kual/dashboard-kindle"), packageDir, { recursive: true });
console.log(`Build verified. Kindle extension staged at ${path.relative(repoPath(), packageDir)}`);
