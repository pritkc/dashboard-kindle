import fs from "node:fs";
import { repoPath } from "../packages/domain/src/core.js";

const packageJson = JSON.parse(fs.readFileSync(repoPath("package.json"), "utf8"));
const dependencyGroups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const dependencyEntries = dependencyGroups.flatMap((group) => Object.entries(packageJson[group] ?? {}).map(([name, version]) => ({ group, name, version })));

if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageJson.packageManager ?? "")) {
  throw new Error("packageManager must pin an exact pnpm version, for example pnpm@10.15.1.");
}

if (dependencyEntries.length === 0) {
  console.log("Dependency audit passed: package manager is pinned and no npm dependencies are declared.");
  process.exit(0);
}

if (!fs.existsSync(repoPath("pnpm-lock.yaml"))) {
  throw new Error("Dependencies are declared, but pnpm-lock.yaml is missing.");
}

const floating = dependencyEntries.filter(({ version }) => /^[*xX]$|latest|workspace:\*|^[~^]/.test(String(version)));
if (floating.length) {
  throw new Error(`Floating dependency ranges are not allowed: ${floating.map((item) => `${item.name}@${item.version}`).join(", ")}`);
}

console.log(`Dependency audit passed for ${dependencyEntries.length} pinned npm dependency declarations.`);
