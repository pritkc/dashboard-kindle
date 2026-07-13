import { hashPayload } from "../../domain/src/core.js";

export const knownProfiles = {
  kindle_basic_600x800: {
    id: "kindle_basic_600x800",
    name: "Kindle basic 600x800",
    width: 600,
    height: 800,
    orientation: "portrait",
    safeArea: { top: 16, right: 16, bottom: 16, left: 16 },
    palette: "monochrome",
    outputFormat: "png",
    dithering: "threshold",
    contrast: 1.15,
    gamma: 1,
    fullRefreshInterval: 6,
    partialRefresh: false,
    touch: false,
    wifiControl: false,
    keepAwake: true,
    scheduledWake: false
  },
  kindle_pw_758x1024: {
    id: "kindle_pw_758x1024",
    name: "Kindle Paperwhite 758x1024",
    width: 758,
    height: 1024,
    orientation: "portrait",
    safeArea: { top: 20, right: 20, bottom: 20, left: 20 },
    palette: "grayscale4",
    outputFormat: "png",
    dithering: "atkinson",
    contrast: 1.1,
    gamma: 1,
    fullRefreshInterval: 8,
    partialRefresh: true,
    touch: true,
    wifiControl: false,
    keepAwake: true,
    scheduledWake: false
  },
  trmnl_800x480: {
    id: "trmnl_800x480",
    name: "TRMNL/BYOD 800x480",
    width: 800,
    height: 480,
    orientation: "landscape",
    safeArea: { top: 12, right: 12, bottom: 12, left: 12 },
    palette: "monochrome",
    outputFormat: "png",
    dithering: "bayer4",
    contrast: 1.05,
    gamma: 1,
    fullRefreshInterval: 4,
    partialRefresh: false,
    touch: false,
    wifiControl: false,
    keepAwake: false,
    scheduledWake: false
  }
};

export function resolveProfile(capabilities = {}, overrides = {}) {
  const { hash: _ignoredHash, ...cleanOverrides } = overrides;
  const base = capabilities.profileId && knownProfiles[capabilities.profileId]
    ? knownProfiles[capabilities.profileId]
    : {
        id: "custom",
        name: "Custom e-ink display",
        width: capabilities.width ?? 800,
        height: capabilities.height ?? 600,
        orientation: capabilities.orientation ?? "landscape",
        safeArea: { top: 12, right: 12, bottom: 12, left: 12 },
        palette: "monochrome",
        outputFormat: "png",
        dithering: "threshold",
        contrast: 1,
        gamma: 1,
        fullRefreshInterval: 6,
        partialRefresh: Boolean(capabilities.partialRefresh),
        touch: Boolean(capabilities.touch),
        wifiControl: Boolean(capabilities.wifiControl),
        keepAwake: Boolean(capabilities.keepAwake),
        scheduledWake: Boolean(capabilities.scheduledWake)
      };
  const profile = { ...base, ...cleanOverrides, safeArea: { ...base.safeArea, ...(cleanOverrides.safeArea ?? {}) } };
  return { ...profile, hash: hashPayload(profile) };
}
