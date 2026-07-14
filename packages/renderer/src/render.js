import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hashPayload, repoPath, selectPath, sha256 } from "../../domain/src/core.js";
import { resolveProfile } from "../../device-profiles/src/profiles.js";

export const RENDERER_VERSION = "dashboard-kindle-renderer-0.1.5";

export function renderFingerprint(revision, snapshots, profile) {
  const snapshotHashes = Object.fromEntries(Object.entries(snapshots).map(([id, snapshot]) => [id, snapshot?.payloadHash ?? "missing"]));
  const hasClockWidget = revision.definition.widgets.some((widget) => widget.type === "clock");
  return hashPayload({
    revisionHash: revision.definitionHash,
    snapshotHashes,
    profileHash: profile.hash,
    rendererVersion: RENDERER_VERSION,
    fontVersion: "system-ui-v1",
    timeBucket: hasClockWidget ? currentRenderDate().toISOString().slice(0, 16) : null
  });
}

function currentRenderDate() {
  const override = process.env.DASHBOARD_KINDLE_RENDER_NOW;
  if (override) {
    const parsed = new Date(override);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

export function renderDashboardSvg(definition, snapshots, requestedProfile = {}) {
  const profile = resolveProfile(definition.profile ?? {}, requestedProfile);
  const width = Number(profile.width);
  const height = Number(profile.height);
  const background = profile.invert ? "#111" : "#fff";
  const foreground = profile.invert ? "#fff" : "#111";
  const muted = profile.invert ? "#bbb" : "#555";
  const diagnostics = [];
  const clipDefs = [];
  const layoutBox = layoutBounds(definition, profile, width, height);
  const body = definition.widgets.map((widget, index) => renderWidget(widget, snapshots, {
    foreground,
    muted,
    background,
    diagnostics,
    layoutBox,
    clipId: `widget-clip-${escapeId(widget.id ?? index)}`,
    clipDefs
  })).join("\n");
  const rotation = rotationTransform(profile, width, height);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${background}"/>
  <style>
    .title{font:700 18px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans","Arial Unicode MS",sans-serif;fill:${muted}}
    .value{font:800 42px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans","Arial Unicode MS",sans-serif;fill:${foreground}}
    .text{font:500 22px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans","Arial Unicode MS",sans-serif;fill:${foreground}}
    .small{font:500 15px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans","Arial Unicode MS",sans-serif;fill:${muted}}
  </style>
  <defs>
  ${clipDefs.join("\n")}
  </defs>
  <g${rotation ? ` transform="${rotation}"` : ""}>
  ${body}
  </g>
  <text x="${width - 14}" y="${height - 12}" text-anchor="end" class="small">dashboard-kindle</text>
</svg>`;
}

export function renderDashboardDiagnostics(definition, snapshots, requestedProfile = {}) {
  const profile = resolveProfile(definition.profile ?? {}, requestedProfile);
  const diagnostics = [];
  const layoutBox = layoutBounds(definition, profile, Number(profile.width), Number(profile.height));
  definition.widgets.forEach((widget, index) => renderWidget(widget, snapshots, {
    foreground: "#111",
    muted: "#555",
    background: "#fff",
    diagnostics,
    layoutBox,
    clipId: `widget-clip-${escapeId(widget.id ?? index)}`,
    clipDefs: []
  }));
  return diagnostics;
}

function renderWidget(widget, snapshots, context) {
  const palette = context;
  const snapshot = snapshots[widget.sourceId];
  const payload = snapshot?.payload;
  const data = snapshot?.state === "error" ? undefined : selectPath(payload, widget.expression);
  const originalBox = { x: Number(widget.x), y: Number(widget.y), w: Number(widget.w), h: Number(widget.h) };
  const { box, clipped } = clippedBox(originalBox, context.layoutBox);
  if (clipped) context.diagnostics.push({ widgetId: widget.id, code: "widget-clipped", message: `Widget ${widget.id} was clipped to the renderable bounds.` });
  const title = escapeXml(widget.title ?? widget.type);
  const stale = snapshot && snapshot.validUntil && Date.parse(snapshot.validUntil) < Date.now();
  const stateLabel = !snapshot ? "missing" : stale ? "stale" : snapshot.state;
  const stateMessage = widgetStateMessage(snapshot, stale);
  context.clipDefs.push(`<clipPath id="${context.clipId}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="4"/></clipPath>`);
  const chrome = `<g>
    <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="4" fill="none" stroke="${palette.foreground}" stroke-width="2"/>
    <text x="${box.x + 14}" y="${box.y + 28}" class="title">${title}</text>
    <text x="${box.x + box.w - 12}" y="${box.y + 24}" text-anchor="end" class="small">${escapeXml(stateLabel)}</text>
  </g>`;
  const content = stateMessage ? renderStateMessage(stateMessage, box, palette) : renderWidgetContent(widget, data, box, palette);
  return `${chrome}\n<g clip-path="url(#${context.clipId})">${content}</g>`;
}

function renderWidgetContent(widget, data, box, palette) {
  switch (widget.type) {
    case "clock":
      return renderClock(box);
    case "metric":
      return renderMetric(data, widget.suffix ?? "", box);
    case "progress":
      return renderProgress(data, box, palette);
    case "list":
      return renderList(data, box);
    case "bars":
      return renderBars(data, box, palette);
    case "status":
      return renderStatus(data, box);
    case "alert":
      return renderAlert(data, box, palette);
    case "text":
      return renderText(data, box);
    default:
      return renderText(data, box);
  }
}

function renderClock({ x, y, w, h }) {
  const date = currentRenderDate();
  const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(date);
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(date);
  return `<text x="${x + w / 2}" y="${y + h / 2 + 16}" text-anchor="middle" class="value" font-size="${Math.min(64, h / 2)}">${escapeXml(time)}</text>
  <text x="${x + w / 2}" y="${y + h - 18}" text-anchor="middle" class="small">${escapeXml(day)}</text>`;
}

function renderMetric(data, suffix, { x, y, w, h }) {
  const value = formatValue(data, suffix);
  const fontSize = value.length > 9 ? Math.max(24, Math.min(42, Math.floor((w - 34) / (value.length * 0.55)))) : 42;
  return `<text x="${x + 16}" y="${y + h / 2 + 18}" class="value" style="font-size:${fontSize}px">${escapeXml(value)}</text>`;
}

function renderProgress(data, { x, y, w, h }, palette) {
  const used = Number(data?.used ?? 0);
  const limit = Number(data?.limit ?? 100);
  const pct = limit > 0 ? Math.max(0, Math.min(1, used / limit)) : 0;
  const barW = w - 32;
  const barY = y + h - 40;
  return `<text x="${x + 16}" y="${y + 68}" class="value">${Math.round(pct * 100)}%</text>
  <text x="${x + 120}" y="${y + 64}" class="small">${escapeXml(`${used}/${limit}`)}</text>
  <rect x="${x + 16}" y="${barY}" width="${barW}" height="16" fill="none" stroke="${palette.foreground}" stroke-width="2"/>
  <rect x="${x + 16}" y="${barY}" width="${Math.round(barW * pct)}" height="16" fill="${palette.foreground}"/>`;
}

function renderList(data, { x, y, w, h }) {
  const maxRows = Math.max(1, Math.floor((h - 56) / 28));
  const rows = Array.isArray(data) ? data.slice(0, maxRows) : [];
  if (rows.length === 0) return renderText("No rows", { x, y, w, h: 80 });
  return rows.map((row, index) => {
    const label = row.name ?? row.title ?? row.summary ?? row.entityId ?? row.date ?? row.startsAt ?? String(row);
    const value = row.minutes !== undefined ? `${row.minutes} min` : row.highF !== undefined && row.lowF !== undefined ? `${row.lowF}-${row.highF}F` : row.number !== undefined ? `#${row.number}` : row.state !== undefined ? `${row.state}${row.unit ?? ""}` : row.value ?? row.location ?? row.author ?? "";
    return `<text x="${x + 16}" y="${y + 62 + index * 28}" class="text">${escapeXml(truncateText(label, Math.floor((w - 110) / 12)))}</text>
    <text x="${x + w - 18}" y="${y + 62 + index * 28}" text-anchor="end" class="small">${escapeXml(truncateText(value, 18))}</text>`;
  }).join("\n");
}

function renderBars(data, { x, y, w, h }, palette) {
  const values = Array.isArray(data) ? data : [];
  const max = Math.max(1, ...values);
  const chartX = x + 16;
  const chartY = y + 48;
  const chartW = w - 32;
  const chartH = h - 74;
  const gap = 2;
  const barW = Math.max(3, Math.floor((chartW - gap * 23) / 24));
  return values.slice(0, 24).map((value, index) => {
    const bh = Math.round((value / max) * chartH);
    const bx = chartX + index * (barW + gap);
    return `<rect x="${bx}" y="${chartY + chartH - bh}" width="${barW}" height="${bh}" fill="${palette.foreground}"/>`;
  }).join("\n");
}

function renderStatus(data, box) {
  const text = data?.message ?? data?.status ?? JSON.stringify(data ?? "Missing data");
  return renderWrappedText(text, box, 22);
}

function renderAlert(data, box, palette) {
  const text = String(data ?? "No alert");
  return `<rect x="${box.x + 16}" y="${box.y + 52}" width="${box.w - 32}" height="${box.h - 72}" fill="none" stroke="${palette.foreground}" stroke-width="3" stroke-dasharray="6 5"/>
  ${renderWrappedText(text, { ...box, x: box.x + 12, y: box.y + 14, w: box.w - 24, h: box.h - 24 }, 22)}`;
}

function renderText(data, box) {
  return renderWrappedText(String(data ?? "Missing data"), box, 24);
}

function renderWrappedText(value, { x, y, w, h = 180 }, size) {
  const words = String(value).split(/\s+/).flatMap((word) => splitLongWord(word, Math.max(8, Math.floor((w - 28) / (size * 0.55)))));
  const lines = [];
  let line = "";
  const maxChars = Math.max(8, Math.floor((w - 28) / (size * 0.55)));
  const maxLines = Math.max(1, Math.floor((h - 48) / (size + 6)));
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const visible = lines.slice(0, maxLines);
  if (lines.length > visible.length) visible[visible.length - 1] = truncateText(visible[visible.length - 1], Math.max(1, maxChars - 1));
  return visible.map((text, index) => `<text x="${x + 16}" y="${y + 62 + index * (size + 6)}" class="text" font-size="${size}">${escapeXml(text)}</text>`).join("\n");
}

function formatValue(value, suffix) {
  if (value === undefined || value === null) return "Missing";
  if (typeof value === "number") return `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }
  return `${String(value)}${suffix}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layoutBounds(definition, profile, width, height) {
  const safeArea = profile.safeArea ?? {};
  if (definition.layout?.useSafeArea === true || profile.enforceSafeArea === true) {
    const left = Number(safeArea.left ?? 0);
    const top = Number(safeArea.top ?? 0);
    const right = Number(safeArea.right ?? 0);
    const bottom = Number(safeArea.bottom ?? 0);
    return { x: left, y: top, w: Math.max(1, width - left - right), h: Math.max(1, height - top - bottom) };
  }
  return { x: 0, y: 0, w: width, h: height };
}

function clippedBox(box, bounds) {
  const x = Math.max(bounds.x, box.x);
  const y = Math.max(bounds.y, box.y);
  const right = Math.min(bounds.x + bounds.w, box.x + box.w);
  const bottom = Math.min(bounds.y + bounds.h, box.y + box.h);
  const clipped = x !== box.x || y !== box.y || right !== box.x + box.w || bottom !== box.y + box.h;
  return {
    clipped,
    box: { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) }
  };
}

function widgetStateMessage(snapshot, stale) {
  if (!snapshot) return "Missing source data";
  if (snapshot.state === "error") return snapshot.diagnostics?.error ?? snapshot.diagnostics?.message ?? "Source error";
  if (stale && snapshot.payload === undefined) return "Stale source data";
  return null;
}

function renderStateMessage(message, box, palette) {
  return `<rect x="${box.x + 14}" y="${box.y + 44}" width="${Math.max(1, box.w - 28)}" height="${Math.max(1, box.h - 58)}" fill="none" stroke="${palette.muted}" stroke-width="2" stroke-dasharray="4 4"/>
  ${renderWrappedText(message, { ...box, y: box.y + 2, h: box.h - 8 }, 20)}`;
}

function truncateText(value, maxChars) {
  const text = String(value ?? "");
  const limit = Math.max(1, maxChars);
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 3))}...` : text;
}

function splitLongWord(word, maxChars) {
  if (word.length <= maxChars) return [word];
  const chunks = [];
  for (let index = 0; index < word.length; index += maxChars) chunks.push(word.slice(index, index + maxChars));
  return chunks;
}

function rotationTransform(profile, width, height) {
  const degrees = Number(profile.rotationDegrees ?? profile.rotation ?? 0);
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 90) return `rotate(90 ${width / 2} ${height / 2}) translate(${(height - width) / 2} ${(height - width) / 2})`;
  if (normalized === 180) return `rotate(180 ${width / 2} ${height / 2})`;
  if (normalized === 270) return `rotate(270 ${width / 2} ${height / 2}) translate(${(width - height) / 2} ${(width - height) / 2})`;
  return "";
}

function escapeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function renderHtml(definition, snapshots, profile) {
  const svg = renderDashboardSvg(definition, snapshots, profile);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>${escapeXml(definition.name)}</title>
  <style>html,body{margin:0;background:#777}body{display:grid;place-items:center;min-height:100vh;padding:12px;box-sizing:border-box}svg{background:white;box-shadow:0 0 0 1px #111;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);width:auto;height:auto}</style>
</head>
<body>
${svg}
<script>window.__DASHBOARD_READY = true;</script>
</body>
</html>`;
}

export function writeRenderArtifact({ artifactId, definition, revision, snapshots, profile, dataDir = repoPath("data") }) {
  const resolvedProfile = resolveProfile(definition.profile ?? {}, profile);
  const fingerprint = renderFingerprint(revision, snapshots, resolvedProfile);
  const dir = path.join(dataDir, "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  const id = artifactId ?? `render-${fingerprint.slice(0, 18)}`;
  const svgPath = path.join(dir, `${id}.svg`);
  const pngPath = path.join(dir, `${id}.png`);
  const pgmPath = path.join(dir, `${id}.pgm`);
  const tempSuffix = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const svgTempPath = path.join(dir, `${id}${tempSuffix}.svg`);
  const pngTempPath = path.join(dir, `${id}${tempSuffix}.png`);
  const pgmTempPath = path.join(dir, `${id}${tempSuffix}.pgm`);
  const svg = renderDashboardSvg(definition, snapshots, resolvedProfile);
  try {
    fs.writeFileSync(svgTempPath, svg);
    convertSvgToPng(svgTempPath, pngTempPath, resolvedProfile);
    convertPngToPgm(pngTempPath, pgmTempPath);
    fs.renameSync(svgTempPath, svgPath);
    fs.renameSync(pngTempPath, pngPath);
    fs.renameSync(pgmTempPath, pgmPath);
  } finally {
    for (const tempPath of [svgTempPath, pngTempPath, pgmTempPath]) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
  }
  const image = fs.readFileSync(pngPath);
  return {
    id,
    dashboardId: revision.dashboardId,
    revisionId: revision.id,
    fingerprint,
    profile: resolvedProfile,
    imagePath: pngPath,
    svgPath,
    pgmPath,
    imageHash: sha256(image),
    contentType: "image/png",
    bytes: image.length,
    createdAt: new Date().toISOString(),
    diagnostics: {
      rendererVersion: RENDERER_VERSION,
      consoleErrors: [],
      failedRequests: [],
      readySignal: "__DASHBOARD_READY"
    }
  };
}

function convertSvgToPng(svgPath, pngPath, profile) {
  const command = fs.existsSync("/opt/homebrew/bin/magick") ? "/opt/homebrew/bin/magick" : "convert";
  const args = [
    svgPath,
    "-background",
    "white",
    "-flatten",
    "-resize",
    `${profile.width}x${profile.height}!`,
    "-colorspace",
    "Gray"
  ];
  if (profile.palette === "monochrome") args.push("-threshold", "55%");
  if (profile.palette === "grayscale4") args.push("-posterize", "4");
  if (profile.palette === "grayscale16") args.push("-posterize", "16");
  args.push(pngPath);
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ImageMagick render failed: ${result.stderr || result.stdout}`);
  }
}

function convertPngToPgm(pngPath, pgmPath) {
  const command = fs.existsSync("/opt/homebrew/bin/magick") ? "/opt/homebrew/bin/magick" : "convert";
  const result = spawnSync(command, [pngPath, "-compress", "none", pgmPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`PGM conversion failed: ${result.stderr || result.stdout}`);
  }
}
