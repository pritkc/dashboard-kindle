import crypto from "node:crypto";
import { sha256 } from "../../domain/src/core.js";

export function createDeviceToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashDeviceToken(token) {
  return sha256(`device-token:${token}`);
}

export function verifyDeviceToken(device, token) {
  return Boolean(device?.tokenHash && token && hashDeviceToken(token) === device.tokenHash);
}

export function parseBearer(header) {
  const match = String(header ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function buildDisplayHeaders(artifact, wakeDecision) {
  return {
    "Content-Type": "image/png",
    ETag: `"${artifact.imageHash}"`,
    "X-Next-Poll-Seconds": String(wakeDecision.nextPollSeconds),
    "X-Render-ID": artifact.id,
    "X-Image-SHA256": artifact.imageHash,
    "X-Full-Refresh": String(Boolean(wakeDecision.fullRefresh))
  };
}
