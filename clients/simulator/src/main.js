import fs from "node:fs";
import path from "node:path";
import { sha256, repoPath } from "../../../packages/domain/src/core.js";

const server = process.env.DASHBOARD_KINDLE_SERVER ?? "http://127.0.0.1:8787";
let token = process.env.DASHBOARD_KINDLE_DEVICE_TOKEN;

if (!token) {
  const enrollment = await postJson(`${server}/api/v1/devices/enroll`, {
    name: "CLI simulator",
    capabilities: { profileId: "kindle_basic_600x800", width: 600, height: 800 }
  });
  token = enrollment.token;
  console.log(`Enrolled ${enrollment.device.id}`);
}

const outputDir = repoPath("data/artifacts/simulator");
fs.mkdirSync(outputDir, { recursive: true });
const etagPath = path.join(outputDir, "etag.txt");
const headers = { Authorization: `Bearer ${token}` };
if (fs.existsSync(etagPath)) headers["If-None-Match"] = fs.readFileSync(etagPath, "utf8").trim();

const response = await fetch(`${server}/api/v1/device/display`, { headers });
if (response.status === 304) {
  console.log(`304 unchanged. Next poll ${response.headers.get("x-next-poll-seconds")}s`);
  process.exit(0);
}
if (!response.ok) throw new Error(`Display fetch failed: ${response.status} ${await response.text()}`);
const contentType = response.headers.get("content-type") ?? "";
if (!contentType.includes("image/png")) throw new Error(`Unexpected content type ${contentType}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) throw new Error("Invalid PNG signature");
const expectedHash = response.headers.get("x-image-sha256");
const actualHash = sha256(bytes);
if (expectedHash !== actualHash) throw new Error(`Hash mismatch ${actualHash} !== ${expectedHash}`);
const target = path.join(outputDir, `${actualHash}.png`);
fs.writeFileSync(`${target}.tmp`, bytes);
fs.renameSync(`${target}.tmp`, target);
fs.writeFileSync(etagPath, response.headers.get("etag") ?? actualHash);
console.log(JSON.stringify({
  status: "stored",
  path: target,
  bytes: bytes.length,
  hash: actualHash,
  nextPollSeconds: response.headers.get("x-next-poll-seconds")
}, null, 2));

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status} ${await response.text()}`);
  return response.json();
}
