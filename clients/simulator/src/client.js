import fs from "node:fs";
import path from "node:path";
import { sha256, repoPath } from "../../../packages/domain/src/core.js";

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngIendChunk = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export function simulatorConfigFromEnv(env = process.env) {
  const width = optionalNumber(env.DASHBOARD_KINDLE_DEVICE_WIDTH);
  const height = optionalNumber(env.DASHBOARD_KINDLE_DEVICE_HEIGHT);
  const capabilities = {
    profileId: env.DASHBOARD_KINDLE_PROFILE_ID ?? "kindle_basic_600x800",
    ...(width ? { width } : {}),
    ...(height ? { height } : {})
  };
  return {
    server: env.DASHBOARD_KINDLE_SERVER ?? "http://127.0.0.1:8787",
    adminToken: env.DASHBOARD_KINDLE_ADMIN_TOKEN ?? "dev-admin-token",
    token: env.DASHBOARD_KINDLE_DEVICE_TOKEN,
    outputDir: path.resolve(env.DASHBOARD_KINDLE_SIMULATOR_DIR ?? repoPath("data/artifacts/simulator")),
    name: env.DASHBOARD_KINDLE_SIMULATOR_NAME ?? "CLI simulator",
    capabilities,
    maxAttempts: optionalNumber(env.DASHBOARD_KINDLE_SIMULATOR_ATTEMPTS) ?? 3,
    baseBackoffMs: optionalNumber(env.DASHBOARD_KINDLE_SIMULATOR_BACKOFF_MS) ?? 250
  };
}

export async function runSimulatorOnce(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const config = {
    ...simulatorConfigFromEnv(),
    ...options
  };
  fs.mkdirSync(config.outputDir, { recursive: true });
  const etagPath = path.join(config.outputDir, "etag.txt");
  const token = config.token ?? await enrollSimulator(config, fetchImpl);
  const etag = readOptionalText(etagPath);
  const response = await fetchWithBackoff(() => fetchDisplay(config.server, token, etag, fetchImpl), {
    maxAttempts: config.maxAttempts,
    baseBackoffMs: config.baseBackoffMs,
    sleep
  });
  if (response.offline) return response;
  return handleDisplayResponse(response, {
    outputDir: config.outputDir,
    etagPath,
    token,
    capabilities: config.capabilities
  });
}

export async function enrollSimulator(config, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.server}/api/v1/devices/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": config.adminToken },
    body: JSON.stringify({
      name: config.name,
      capabilities: config.capabilities
    })
  });
  if (!response.ok) throw new Error(`POST ${config.server}/api/v1/devices/enroll failed: ${response.status} ${await response.text()}`);
  const enrollment = await response.json();
  return enrollment.token;
}

export async function handleDisplayResponse(response, context) {
  const nextPollSeconds = normalizedPositiveNumber(response.headers.get("x-next-poll-seconds"));
  const etag = response.headers.get("etag");
  if (response.status === 304) {
    if (etag) writeAtomic(context.etagPath, etag);
    return {
      status: "unchanged",
      etag,
      nextPollSeconds
    };
  }
  if (!response.ok) throw new Error(`Display fetch failed: ${response.status} ${await response.text()}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("image/png")) throw new Error(`Unexpected content type ${contentType || "(missing)"}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  validatePng(bytes);
  const expectedHash = response.headers.get("x-image-sha256");
  if (!expectedHash) throw new Error("Missing X-Image-SHA256 header");
  const actualHash = sha256(bytes);
  if (expectedHash !== actualHash) throw new Error(`Hash mismatch ${actualHash} !== ${expectedHash}`);
  const target = path.join(context.outputDir, `${actualHash}.png`);
  writeAtomic(target, bytes);
  writeAtomic(context.etagPath, etag ?? `"${actualHash}"`);
  const metadata = {
    status: "stored",
    path: target,
    bytes: bytes.length,
    hash: actualHash,
    etag: etag ?? `"${actualHash}"`,
    nextPollSeconds,
    fullRefresh: response.headers.get("x-full-refresh") === "true",
    renderId: response.headers.get("x-render-id") ?? null,
    capabilities: context.capabilities
  };
  writeAtomic(path.join(context.outputDir, "latest.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export function validatePng(bytes) {
  if (bytes.length < pngSignature.length + pngIendChunk.length) throw new Error("Truncated PNG download");
  if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error("Invalid PNG signature");
  if (!bytes.subarray(bytes.length - pngIendChunk.length).equals(pngIendChunk)) throw new Error("Truncated PNG download");
}

async function fetchDisplay(server, token, etag, fetchImpl) {
  const headers = { Authorization: `Bearer ${token}` };
  if (etag) headers["If-None-Match"] = etag;
  return fetchImpl(`${server}/api/v1/device/display`, { headers });
}

async function fetchWithBackoff(operation, options) {
  const maxAttempts = Math.max(1, Math.round(options.maxAttempts ?? 1));
  const baseBackoffMs = Math.max(0, Math.round(options.baseBackoffMs ?? 0));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await options.sleep(baseBackoffMs * 2 ** (attempt - 1));
    }
  }
  return {
    offline: true,
    status: "offline",
    attempts: maxAttempts,
    error: lastError?.message ?? "Display endpoint unavailable",
    nextRetryMs: baseBackoffMs * 2 ** Math.max(0, maxAttempts - 1)
  };
}

function readOptionalText(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const value = fs.readFileSync(filePath, "utf8").trim();
  return value || null;
}

function writeAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, value);
  fs.renameSync(tempPath, filePath);
}

function optionalNumber(value) {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizedPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
