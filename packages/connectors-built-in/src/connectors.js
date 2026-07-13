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
    case "weather.open-meteo":
      return collectWeather(instance);
    case "calendar.ics":
      return collectCalendar(instance);
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
  const { url, method = "GET", headers = {}, body, allowPrivateNetwork = false } = instance.config;
  if (url === "fixture://http") return readJson(repoPath("data/fixtures/http.json"), {});
  if (!allowPrivateNetwork && isPrivateNetworkUrl(url)) {
    throw new Error("Blocked private-network HTTP connector target. Enable allowPrivateNetwork only for trusted local deployments.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), instance.timeoutMs ?? 5000);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { accept: "application/json", ...normalizedHeaders(headers) },
      body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined
    });
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

async function collectWeather(instance) {
  const { mode = "open-meteo", locationName = "Weather", latitude, longitude, timezone = "auto", units = "metric" } = instance.config;
  if (mode === "fixture") return readJson(repoPath("data/fixtures/weather.json"), {});
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
    throw new Error("Weather connector requires latitude and longitude for Open-Meteo mode.");
  }
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    timezone,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum",
    forecast_days: "3"
  });
  if (units === "imperial") {
    params.set("temperature_unit", "fahrenheit");
    params.set("wind_speed_unit", "mph");
  }
  const response = await fetchLimited(`https://api.open-meteo.com/v1/forecast?${params}`, {
    accept: "application/json"
  }, instance.timeoutMs);
  const payload = JSON.parse(response);
  return normalizeWeatherPayload(payload, { locationName, units });
}

async function collectCalendar(instance) {
  const { url, allowPrivateNetwork = false, maxEvents = 8 } = instance.config;
  const text = url === "fixture://calendar" ? fs.readFileSync(repoPath("data/fixtures/calendar.ics"), "utf8") : await fetchCalendarText(url, allowPrivateNetwork, instance.timeoutMs);
  return parseICalendar(text, maxEvents);
}

async function fetchCalendarText(url, allowPrivateNetwork, timeoutMs) {
  if (!allowPrivateNetwork && isPrivateNetworkUrl(url)) {
    throw new Error("Blocked private-network calendar target.");
  }
  return fetchLimited(url, { accept: "text/calendar, text/plain" }, timeoutMs);
}

async function fetchLimited(url, headers, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body) > OUTPUT_LIMIT_BYTES) throw new Error("Connector output exceeded size limit");
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function normalizeWeatherPayload(payload, { locationName, units }) {
  const current = payload.current ?? {};
  const daily = payload.daily ?? {};
  const temperature = Number(current.temperature_2m);
  const apparent = Number(current.apparent_temperature);
  const wind = Number(current.wind_speed_10m);
  const metric = units !== "imperial";
  return {
    location: locationName,
    timezone: payload.timezone ?? "UTC",
    current: {
      temperatureC: metric ? temperature : fahrenheitToCelsius(temperature),
      temperatureF: metric ? celsiusToFahrenheit(temperature) : temperature,
      apparentTemperatureC: metric ? apparent : fahrenheitToCelsius(apparent),
      apparentTemperatureF: metric ? celsiusToFahrenheit(apparent) : apparent,
      humidity: Number(current.relative_humidity_2m ?? 0),
      precipitationMm: Number(current.precipitation ?? 0),
      windKph: metric ? wind : mphToKph(wind),
      condition: weatherCodeLabel(current.weather_code),
      observedAt: current.time ?? new Date().toISOString()
    },
    daily: (daily.time ?? []).slice(0, 3).map((date, index) => {
      const high = Number(daily.temperature_2m_max?.[index]);
      const low = Number(daily.temperature_2m_min?.[index]);
      return {
        date,
        highC: metric ? high : fahrenheitToCelsius(high),
        lowC: metric ? low : fahrenheitToCelsius(low),
        highF: metric ? celsiusToFahrenheit(high) : high,
        lowF: metric ? celsiusToFahrenheit(low) : low,
        precipitationMm: Number(daily.precipitation_sum?.[index] ?? 0)
      };
    })
  };
}

function parseICalendar(text, maxEvents = 8) {
  const events = [];
  for (const block of text.split("BEGIN:VEVENT").slice(1)) {
    const eventText = block.split("END:VEVENT")[0] ?? "";
    const event = {
      uid: icalField(eventText, "UID"),
      title: icalField(eventText, "SUMMARY") ?? "Untitled event",
      location: icalField(eventText, "LOCATION"),
      startsAt: parseIcalDate(icalField(eventText, "DTSTART")),
      endsAt: parseIcalDate(icalField(eventText, "DTEND"))
    };
    if (event.startsAt && Date.parse(event.startsAt) >= Date.now() - 24 * 60 * 60 * 1000) events.push(event);
  }
  events.sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  return {
    title: icalField(text, "X-WR-CALNAME") ?? "Calendar",
    events: events.slice(0, Number(maxEvents) || 8)
  };
}

function icalField(text, name) {
  const normalized = unfoldIcal(text);
  const pattern = new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "im");
  const value = normalized.match(pattern)?.[1];
  return value ? decodeIcalText(value.trim()) : null;
}

function unfoldIcal(text) {
  return text.replace(/\r?\n[ \t]/g, "");
}

function parseIcalDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) return raw;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${raw.endsWith("Z") ? "Z" : ""}`;
}

function decodeIcalText(value) {
  return String(value)
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function weatherCodeLabel(code) {
  const labels = {
    0: "clear",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "depositing rime fog",
    51: "light drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    71: "light snow",
    80: "rain showers",
    95: "thunderstorm"
  };
  return labels[Number(code)] ?? "unknown";
}

function celsiusToFahrenheit(value) {
  return Math.round((Number(value) * 9 / 5 + 32) * 10) / 10;
}

function fahrenheitToCelsius(value) {
  return Math.round(((Number(value) - 32) * 5 / 9) * 10) / 10;
}

function mphToKph(value) {
  return Math.round(Number(value) * 1.60934 * 10) / 10;
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
