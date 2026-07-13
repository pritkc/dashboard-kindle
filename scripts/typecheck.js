import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--check", "apps/server/src/main.js"], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status);
console.log("Syntax check passed for server entrypoint.");
