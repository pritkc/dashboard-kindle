import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { repoPath } from "../packages/domain/src/core.js";

const image = process.env.DASHBOARD_KINDLE_SMOKE_IMAGE;
const port = await freePort();
const adminToken = "smoke-admin-token";
const masterKey = "smoke-master-key";
const timeoutMs = 20_000;

if (image) {
  await smokeDockerImage(image, port);
} else {
  await smokeNodeServer(port);
}

async function smokeNodeServer(targetPort) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-smoke-"));
  const child = spawn(process.execPath, ["apps/server/src/main.js"], {
    cwd: repoPath(),
    env: {
      ...process.env,
      DASHBOARD_KINDLE_HOST: "127.0.0.1",
      DASHBOARD_KINDLE_PORT: String(targetPort),
      DASHBOARD_KINDLE_DATA_DIR: dataDir,
      DASHBOARD_KINDLE_ADMIN_TOKEN: adminToken,
      DASHBOARD_KINDLE_MASTER_KEY: masterKey,
      DASHBOARD_KINDLE_SCHEDULER_TICK_MS: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    await waitForHealth(targetPort);
    await assertSmokeRoutes(targetPort);
    console.log("Container smoke passed against local Node server.");
  } finally {
    child.kill("SIGTERM");
    await onceExit(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function smokeDockerImage(targetImage, targetPort) {
  const containerName = `dashboard-kindle-smoke-${process.pid}`;
  const run = spawnSync("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    "-p",
    `127.0.0.1:${targetPort}:8787`,
    "-e",
    `DASHBOARD_KINDLE_ADMIN_TOKEN=${adminToken}`,
    "-e",
    `DASHBOARD_KINDLE_MASTER_KEY=${masterKey}`,
    "-e",
    "DASHBOARD_KINDLE_SCHEDULER_TICK_MS=0",
    targetImage
  ], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
  try {
    await waitForHealth(targetPort);
    await assertSmokeRoutes(targetPort);
    console.log(`Container smoke passed against ${targetImage}.`);
  } finally {
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "inherit" });
  }
}

async function assertSmokeRoutes(targetPort) {
  const health = await jsonFetch(`http://127.0.0.1:${targetPort}/api/v1/health`);
  if (health.status !== "ok" || health.adminAuth !== true) throw new Error(`Unexpected health payload: ${JSON.stringify(health)}`);
  const unauthorized = await fetch(`http://127.0.0.1:${targetPort}/api/v1/state`);
  if (unauthorized.status !== 401) throw new Error(`Expected /api/v1/state without auth to return 401, got ${unauthorized.status}`);
  const root = await fetch(`http://127.0.0.1:${targetPort}/`);
  if (root.status !== 200) throw new Error(`Expected / to return 200, got ${root.status}`);
}

async function waitForHealth(targetPort) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/api/v1/health`);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for health endpoint: ${lastError?.message ?? "no response"}`);
}

async function jsonFetch(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function onceExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
  });
}
