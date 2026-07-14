import fs from "node:fs";
import path from "node:path";
import { repoPath } from "../packages/domain/src/core.js";

const ignoredDirs = new Set([".git", "node_modules", ".playwright-cli", ".specstory", ".vscode"]);
const ignoredPaths = new Set(["data/state.json"]);
const ignoredPathPrefixes = ["data/backups/", "data/artifacts/"];
const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".tgz", ".gz", ".zip"]);
const patterns = [
  { name: "private key", regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |)?PRIVATE KEY-----/g },
  { name: "GitHub token", regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { name: "AWS access key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: "Stripe live secret key", regex: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
  { name: "long bearer token", regex: /\bBearer\s+[A-Za-z0-9._~+/-]{32,}=*\b/g }
];

const findings = [];
for (const file of walk(repoPath())) {
  const relative = path.relative(repoPath(), file).replaceAll(path.sep, "/");
  if (shouldIgnore(relative, file)) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      findings.push({ file: relative, line, name: pattern.name });
    }
  }
}

if (findings.length) {
  const summary = findings.map((finding) => `${finding.file}:${finding.line} ${finding.name}`).join("\n");
  throw new Error(`Potential exposed secrets found:\n${summary}`);
}

console.log("Secret scan passed.");

function shouldIgnore(relative, file) {
  if (ignoredPaths.has(relative)) return true;
  if (ignoredPathPrefixes.some((prefix) => relative.startsWith(prefix))) return true;
  if (binaryExtensions.has(path.extname(file).toLowerCase())) return true;
  const stat = fs.statSync(file);
  if (stat.size > 2_000_000) return true;
  return false;
}

function walk(dir, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else output.push(full);
  }
  return output;
}
