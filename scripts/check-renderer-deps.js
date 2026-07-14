import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const commands = [
  { name: "rsvg-convert", candidates: ["/opt/homebrew/bin/rsvg-convert", "rsvg-convert"], install: "brew install librsvg  # or apt install librsvg2-bin" },
  { name: "magick", candidates: ["/opt/homebrew/bin/magick", "magick", "convert"], install: "brew install imagemagick" }
];

function resolveCommand(candidates) {
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && fs.existsSync(candidate)) return candidate;
    const result = spawnSync("sh", ["-c", `command -v ${candidate}`], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return null;
}

export function checkRendererDeps({ quiet = false } = {}) {
  const resolved = {};
  for (const tool of commands) {
    resolved[tool.name] = resolveCommand(tool.candidates);
    if (!resolved[tool.name]) {
      throw new Error(`Missing ${tool.name}. Install with: ${tool.install}`);
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-kindle-deps-"));
  const svgPath = path.join(tempDir, "check.svg");
  const pngPath = path.join(tempDir, "check.png");
  fs.writeFileSync(svgPath, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32">
  <rect width="100%" height="100%" fill="#fff"/>
  <text x="8" y="22" font-family="sans-serif" font-size="16" fill="#111">ok</text>
</svg>`);

  const rsvg = spawnSync(resolved["rsvg-convert"], ["--background-color=white", "-w", "64", "-h", "32", "-o", pngPath, svgPath], { encoding: "utf8" });
  if (rsvg.status !== 0) {
    throw new Error(`rsvg-convert smoke test failed:\n${rsvg.stderr || rsvg.stdout}`);
  }

  const magick = spawnSync(resolved.magick, [pngPath, "-colorspace", "Gray", path.join(tempDir, "check-gray.png")], { encoding: "utf8" });
  if (magick.status !== 0) {
    throw new Error(`ImageMagick smoke test failed:\n${magick.stderr || magick.stdout}`);
  }

  if (!quiet) {
    console.log("Renderer dependencies OK:");
    console.log(`  rsvg-convert: ${resolved["rsvg-convert"]}`);
    console.log(`  magick: ${resolved.magick}`);
  }
  return resolved;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkRendererDeps();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
