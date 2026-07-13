import fs from "node:fs";
import { createSnapshot, isPrivateNetworkUrl, readJson, repoPath } from "../../domain/src/core.js";

const OUTPUT_LIMIT_BYTES = 512 * 1024;

export async function collectConnector(instance, options = {}) {
  const started = Date.now();
  const payload = await collectPayload(instance, options);
  return createSnapshot(instance, payload, {
    durationMs: Date.now() - started,
    state: "fresh",
    observedAt: options.observedAt
  });
}

async function collectPayload(instance, options) {
  switch (instance.connectorId) {
    case "static.manual":
      return instance.config.payload ?? {};
    case "codexbar.usage":
      return collectCodexBar(instance, options);
    case "activitywatch.summary":
      return collectActivityWatch(instance, options);
    case "http.json":
      return collectHttpJson(instance);
    case "webhook.json":
      return instance.config.latestPayload ?? instance.config.initialPayload ?? {};
    case "file.json":
      return readJson(restrictedPath(instance.config.path), {});
    case "file.csv":
      return { rows: parseCsv(fs.readFileSync(restrictedPath(instance.config.path), "utf8")) };
    case "rss.atom":
      return collectFeed(instance);
    case "local.command.json":
      return {
        status: "blocked",
        reason: "Command execution is agent-gated in this build. Configure an allowlist before enabling production commands."
      };
    default:
      throw new Error(`Unknown connector ${instance.connectorId}`);
  }
}

async function collectCodexBar(instance) {
  if (instance.config.mode === "fixture") return readJson(repoPath("data/fixtures/codexbar.json"), {});
  throw new Error("CodexBar local HTTP and CLI collection require the outbound local agent.");
}

async function collectActivityWatch(instance) {
  if (instance.config.mode === "fixture") return readJson(repoPath("data/fixtures/activitywatch.json"), {});
  throw new Error("ActivityWatch collection is intentionally local-agent only.");
}

async function collectHttpJson(instance) {
  const { url, allowPrivateNetwork = false } = instance.config;
  if (url === "fixture://http") return readJson(repoPath("data/fixtures/http.json"), {});
  if (!allowPrivateNetwork && isPrivateNetworkUrl(url)) {
    throw new Error("Blocked private-network HTTP connector target. Enable allowPrivateNetwork only for trusted local deployments.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), instance.timeoutMs ?? 5000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body) > OUTPUT_LIMIT_BYTES) throw new Error("HTTP connector output exceeded size limit");
    return JSON.parse(body);
  } finally {
    clearTimeout(timeout);
  }
}

async function collectFeed(instance) {
  const { url, allowPrivateNetwork = false } = instance.config;
  if (!allowPrivateNetwork && isPrivateNetworkUrl(url)) {
    throw new Error("Blocked private-network feed target.");
  }
  const response = await fetch(url, { headers: { accept: "application/rss+xml, application/atom+xml, text/xml" } });
  if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
  const xml = await response.text();
  if (Buffer.byteLength(xml) > OUTPUT_LIMIT_BYTES) throw new Error("Feed output exceeded size limit");
  const titles = [...xml.matchAll(/<title[^>]*>([^<]+)<\/title>/gi)].slice(0, 8).map((match) => decodeXml(match[1]));
  return { title: titles[0] ?? "Feed", entries: titles.slice(1).map((title) => ({ title })) };
}

function restrictedPath(rawPath) {
  const resolved = repoPath(rawPath);
  const allowed = repoPath("data");
  if (!resolved.startsWith(allowed)) throw new Error("File connector path must stay under ./data");
  return resolved;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = splitCsvLine(lines.shift() ?? "");
  return lines.map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function decodeXml(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
