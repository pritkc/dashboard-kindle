import fs from "node:fs";
import path from "node:path";
import { repoPath } from "../packages/domain/src/core.js";

const required = [
  "apps/server/src/main.js",
  "apps/server/public/index.html",
  "clients/kindle-kual/dashboard-kindle/menu.json",
  "clients/kindle-kual/dashboard-kindle/bin/dashboard-kindle.sh",
  "clients/simulator/src/main.js",
  "apps/agent/src/main.js",
  "scripts/agent-install-macos.sh",
  "scripts/agent-uninstall-macos.sh",
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

const launcherDir = repoPath("data/artifacts/dashboard-kindle-local-launcher");
fs.rmSync(launcherDir, { recursive: true, force: true });
fs.mkdirSync(path.join(launcherDir, "apps/agent/src"), { recursive: true });
fs.mkdirSync(path.join(launcherDir, "scripts"), { recursive: true });
fs.mkdirSync(path.join(launcherDir, "docs"), { recursive: true });
for (const file of [
  "apps/agent/src/main.js",
  "scripts/agent-install-macos.sh",
  "scripts/agent-uninstall-macos.sh",
  "docs/agent.md",
  "README.md",
  "package.json"
]) {
  fs.cpSync(repoPath(file), path.join(launcherDir, file), { recursive: true });
}
fs.writeFileSync(path.join(launcherDir, "manifest.json"), `${JSON.stringify({
  name: "dashboard-kindle-local-launcher",
  version: "0.1.0",
  signed: false,
  entrypoints: {
    status: "node apps/agent/src/main.js status",
    installMacos: "sh scripts/agent-install-macos.sh",
    uninstallMacos: "sh scripts/agent-uninstall-macos.sh"
  },
  note: "Unsigned local-agent launcher package. Signed macOS or Windows installers require signing credentials outside this repository."
}, null, 2)}\n`);

console.log(`Build verified. Kindle extension staged at ${path.relative(repoPath(), packageDir)}`);
console.log(`Unsigned local launcher staged at ${path.relative(repoPath(), launcherDir)}`);
