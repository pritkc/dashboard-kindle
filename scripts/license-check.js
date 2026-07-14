import fs from "node:fs";
import { repoPath } from "../packages/domain/src/core.js";

const packageJson = JSON.parse(fs.readFileSync(repoPath("package.json"), "utf8"));
const licenseText = fs.readFileSync(repoPath("LICENSE"), "utf8");
const notices = fs.readFileSync(repoPath("THIRD_PARTY_NOTICES.md"), "utf8");
const dockerfile = fs.readFileSync(repoPath("Dockerfile"), "utf8");
const ci = fs.readFileSync(repoPath(".github/workflows/ci.yml"), "utf8");

if (packageJson.license !== "MIT") throw new Error("package.json must declare the MIT license used by LICENSE.");
if (!licenseText.startsWith("MIT License")) throw new Error("LICENSE must contain the MIT license text.");
if (!notices.includes("This repository currently contains original source code and no vendored third-party code.")) {
  throw new Error("THIRD_PARTY_NOTICES.md must document whether third-party code is vendored.");
}
if (/^FROM\s+\S+:(latest|bookworm|slim)\b/m.test(dockerfile)) {
  throw new Error("Dockerfile must not use a floating base image tag.");
}
if (!/^FROM\s+node:\d+\.\d+\.\d+-bookworm-slim$/m.test(dockerfile)) {
  throw new Error("Dockerfile must pin the Node image with an exact version.");
}
if (!/node-version:\s*"\d+\.\d+\.\d+"/.test(ci)) {
  throw new Error("CI must pin an exact Node.js version.");
}

console.log("License and runtime pinning check passed.");
