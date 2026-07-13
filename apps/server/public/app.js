const state = {
  data: null,
  templates: [],
  dashboardId: "work",
  authenticated: false,
  busy: false
};

const profiles = {
  work: null,
  kindle_basic_600x800: {
    id: "kindle_basic_600x800",
    name: "Kindle basic 600x800",
    width: 600,
    height: 800,
    orientation: "portrait",
    palette: "monochrome",
    outputFormat: "png",
    dithering: "threshold",
    contrast: 1.15,
    gamma: 1
  },
  kindle_pw_758x1024: {
    id: "kindle_pw_758x1024",
    name: "Kindle Paperwhite 758x1024",
    width: 758,
    height: 1024,
    orientation: "portrait",
    palette: "grayscale4",
    outputFormat: "png",
    dithering: "atkinson",
    contrast: 1.1,
    gamma: 1
  },
  trmnl_800x480: {
    id: "trmnl_800x480",
    name: "TRMNL/BYOD 800x480",
    width: 800,
    height: 480,
    orientation: "landscape",
    palette: "monochrome",
    outputFormat: "png",
    dithering: "bayer4",
    contrast: 1.05,
    gamma: 1
  }
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options
  });
  if (response.status === 401) {
    state.authenticated = false;
    updateAuthUi();
    throw new Error("Administrator authentication required.");
  }
  const text = await response.text();
  if (!response.ok) throw new Error(parseApiError(text, response.status));
  return text ? JSON.parse(text) : {};
}

function parseApiError(text, status) {
  try {
    return JSON.parse(text).error ?? `${status} ${text}`;
  } catch {
    return `${status} ${text}`;
  }
}

async function login(token) {
  await api("/api/v1/admin/session", {
    method: "POST",
    body: JSON.stringify({ token })
  });
  state.authenticated = true;
  localStorage.setItem("dashboardKindleAdminToken", token);
  updateAuthUi();
  await loadControlPlaneState();
  render();
  setStatus("Unlocked.");
}

async function logout() {
  await api("/api/v1/admin/session", { method: "DELETE" }).catch(() => {});
  localStorage.removeItem("dashboardKindleAdminToken");
  state.authenticated = false;
  state.data = null;
  updateAuthUi();
  setStatus("Locked. Enter the administrator token to continue.");
}

async function refresh() {
  await withAction("Refreshing state", async () => {
    await reloadState("State refreshed.");
  });
}

async function loadControlPlaneState() {
  const [data, templates] = await Promise.all([
    api("/api/v1/state"),
    api("/api/v1/dashboard-templates")
  ]);
  state.data = data;
  state.templates = templates;
}

async function reloadState(statusMessage) {
  await loadControlPlaneState();
  state.authenticated = true;
  updateAuthUi();
  render();
  if (statusMessage) setStatus(statusMessage);
}

function render() {
  if (!state.data) return;
  const dashboards = state.data.dashboards;
  if (!dashboards.find((dashboard) => dashboard.id === state.dashboardId)) {
    state.dashboardId = dashboards[0]?.id;
  }
  renderDashboardList();
  renderSetup();
  renderTemplates();
  renderSources();
  renderSourceWizard();
  renderDevices();
  renderPairingDefaults();
  renderSelects();
  renderInspector();
  renderPreview();
}

function renderSetup() {
  const setup = state.data.setup;
  $("setupChecklist").innerHTML = setup.steps.map((step) => `
    <div class="item ${step.done ? "done" : ""} ${setup.nextStep === step.id ? "current" : ""}">
      <strong>${step.done ? "Done" : setup.nextStep === step.id ? "Next" : "Pending"}</strong>
      <span>${escapeHtml(step.label)}</span>
    </div>
  `).join("");
  $("completeSetup").disabled = state.busy || !state.authenticated || setup.completed;
}

function renderDashboardList() {
  $("dashboards").innerHTML = state.data.dashboards.map((dashboard) => `
    <button class="item secondary" data-dashboard="${dashboard.id}">
      <strong>${escapeHtml(dashboard.name)}</strong>
      <span>${escapeHtml(dashboard.currentRevisionId ?? "draft only")}</span>
    </button>
  `).join("");
  document.querySelectorAll("[data-dashboard]").forEach((button) => {
    button.addEventListener("click", () => {
      state.dashboardId = button.dataset.dashboard;
      render();
    });
  });
}

function renderTemplates() {
  const current = $("templateSelect").value;
  $("templateSelect").innerHTML = state.templates.map((template) => `
    <option value="${template.id}">${escapeHtml(template.name)} (${template.preview.profile.width}x${template.preview.profile.height})</option>
  `).join("");
  if (state.templates.find((template) => template.id === current)) $("templateSelect").value = current;
}

function renderSources() {
  $("sources").innerHTML = state.data.connectorInstances.map((source) => {
    const health = state.data.sourceHealth[source.id];
    const snapshot = state.data.snapshots[source.id];
    const job = sourceJobFor(source.id);
    const nextText = job?.enabled ? `next ${formatRelativeTime(job.nextRunAt)}` : "schedule paused";
    const failureText = job?.consecutiveFailures ? ` · backoff ${job.consecutiveFailures} failure${job.consecutiveFailures === 1 ? "" : "s"}` : "";
    return `<div class="item">
      <strong>${escapeHtml(source.name)}</strong>
      <span>${escapeHtml(source.connectorId)} · ${escapeHtml(health?.state ?? "not collected")}</span>
      <span>${escapeHtml(snapshot?.payloadHash?.slice(0, 12) ?? "no snapshot")}</span>
      <span>${escapeHtml(nextText + failureText)}</span>
    </div>`;
  }).join("");
}

function sourceJobFor(sourceId) {
  return state.data.scheduler?.jobs?.find((job) => job.sourceId === sourceId);
}

function renderSourceWizard() {
  const current = $("sourceConnector").value;
  $("sourceConnector").innerHTML = state.data.connectorManifests.map((manifest) => `
    <option value="${manifest.id}">${escapeHtml(manifest.displayName)}</option>
  `).join("");
  if (state.data.connectorManifests.find((manifest) => manifest.id === current)) {
    $("sourceConnector").value = current;
  }
  if (!$("sourceConfig").value.trim()) fillSourceDefaults();
}

function renderDevices() {
  $("devices").innerHTML = state.data.devices.map((device) => {
    const assignment = state.data.assignments[device.id];
    const checkin = state.data.deviceCheckins[device.id];
    return `<div class="item">
      <strong>${escapeHtml(device.name)}</strong>
      <span>${escapeHtml(device.profile.name)} · ${escapeHtml(assignment?.dashboardId ?? "unassigned")}</span>
      <span>${escapeHtml(checkin?.lastSeenAt ? `last seen ${checkin.lastSeenAt}` : "not seen yet")}</span>
    </div>`;
  }).join("");
}

function renderPairingDefaults() {
  if (!$("pairServerUrl").value) $("pairServerUrl").value = window.location.origin;
}

function renderSelects() {
  $("dashboardSelect").innerHTML = state.data.dashboards.map((dashboard) => `<option value="${dashboard.id}">${escapeHtml(dashboard.name)}</option>`).join("");
  $("dashboardSelect").value = state.dashboardId;
  $("deviceSelect").innerHTML = state.data.devices.map((device) => `<option value="${device.id}">${escapeHtml(device.name)}</option>`).join("");
  const dashboard = state.data.dashboards.find((item) => item.id === state.dashboardId);
  if (document.activeElement !== $("definition")) {
    $("definition").value = JSON.stringify(dashboard?.draft ?? {}, null, 2);
  }
}

function renderInspector() {
  const dashboard = state.data.dashboards.find((item) => item.id === state.dashboardId);
  const revisions = state.data.dashboardRevisions.filter((revision) => revision.dashboardId === state.dashboardId);
  const artifact = latestArtifact();
  $("inspector").innerHTML = dl({
    "Dashboard": dashboard?.name,
    "Revision": dashboard?.currentRevisionId,
    "Revision count": revisions.length,
    "Widgets": dashboard?.draft?.widgets?.length ?? 0,
    "Profile": `${dashboard?.draft?.profile?.width}x${dashboard?.draft?.profile?.height}`,
    "Preview": artifact ? "processed PNG" : "render route"
  });
  $("artifact").textContent = artifact ? JSON.stringify({
    id: artifact.id,
    imageHash: artifact.imageHash,
    bytes: artifact.bytes,
    imagePath: artifact.imagePath,
    pgmPath: artifact.pgmPath
  }, null, 2) : "No render yet.";
}

function latestArtifact() {
  return [...state.data.renderArtifacts].reverse().find((item) => item.dashboardId === state.dashboardId);
}

function renderPreview() {
  const artifact = latestArtifact();
  if (artifact) {
    $("preview").hidden = true;
    $("processedPreview").hidden = false;
    $("processedPreview").src = `/api/v1/render-artifacts/${artifact.id}/image?cache=${Date.now()}`;
  } else {
    $("processedPreview").hidden = true;
    $("preview").hidden = false;
    $("preview").src = `/render/${state.dashboardId}?cache=${Date.now()}`;
  }
}

function dl(values) {
  return Object.entries(values).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value ?? "")}</dd>`).join("");
}

async function collectAll() {
  await withAction("Collecting sources", async () => {
    for (const source of state.data.connectorInstances) {
      await api(`/api/v1/sources/${source.id}/collect`, { method: "POST" });
    }
    await reloadState("Sources collected.");
  });
}

async function runDueSources() {
  await withAction("Running due source jobs", async () => {
    const result = await api("/api/v1/scheduler/run-due", { method: "POST" });
    await reloadState(`Ran ${result.ran} due source job${result.ran === 1 ? "" : "s"}.`);
  });
}

async function completeSetup() {
  await withAction("Completing setup", async () => {
    await api("/api/v1/setup/complete", { method: "POST" });
    await reloadState("Setup marked complete.");
  });
}

async function cloneTemplate() {
  await withAction("Creating dashboard from template", async () => {
    const templateId = $("templateSelect").value;
    const name = $("templateName").value.trim();
    const result = await api(`/api/v1/dashboard-templates/${templateId}/clone`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {})
    });
    state.dashboardId = result.dashboard.id;
    $("templateName").value = "";
    await reloadState("Dashboard created from template.");
  });
}

async function testSource() {
  await withAction("Testing source", async () => {
    const result = await api("/api/v1/sources/test", {
      method: "POST",
      body: JSON.stringify(sourceInput())
    });
    renderSourceFields(result.fields);
    setStatus(`Source test succeeded. Snapshot ${result.snapshot.id}.`);
  });
}

async function saveSource() {
  await withAction("Saving source", async () => {
    const result = await api("/api/v1/sources", {
      method: "POST",
      body: JSON.stringify(sourceInput())
    });
    renderSourceFields(result.snapshot ? dataFieldsFromSnapshot(result.snapshot) : []);
    await reloadState();
    const webhookText = result.webhookUrl ? ` Webhook URL: ${result.webhookUrl}` : "";
    setStatus(`Source saved.${webhookText}`);
  });
}

function sourceInput() {
  const id = $("sourceId").value.trim();
  const name = $("sourceName").value.trim();
  return {
    connectorId: $("sourceConnector").value,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    collectionIntervalSeconds: Number($("sourceInterval").value),
    config: parseJson($("sourceConfig").value, "Source configuration JSON")
  };
}

function fillSourceDefaults() {
  const manifest = state.data?.connectorManifests.find((item) => item.id === $("sourceConnector").value);
  if (!manifest) return;
  $("sourceConfig").value = JSON.stringify(defaultConnectorConfig(manifest), null, 2);
  $("sourceInterval").value = String(selectIntervalOption(manifest.defaultCollectionIntervalSeconds ?? 300));
}

function defaultConnectorConfig(manifest) {
  if (manifest.id === "static.manual") return { payload: { metric: 73, alert: "All systems nominal" } };
  if (manifest.id === "http.json") return { url: "fixture://http" };
  if (manifest.id === "webhook.json") return { initialPayload: { message: "Waiting for first webhook payload" } };
  if (manifest.id === "rss.atom") return { url: "https://hnrss.org/frontpage" };
  const config = {};
  for (const [key, definition] of Object.entries(manifest.configSchema?.properties ?? {})) {
    if (!(manifest.configSchema?.required ?? []).includes(key)) continue;
    config[key] = defaultValueForSchema(definition);
  }
  return config;
}

function defaultValueForSchema(definition) {
  if (definition.type === "object") return {};
  if (definition.type === "array") return [];
  if (definition.type === "boolean") return false;
  if (definition.type === "number") return 0;
  return "";
}

function selectIntervalOption(seconds) {
  const options = [...$("sourceInterval").options].map((option) => Number(option.value));
  return options.find((value) => value >= seconds) ?? options[0];
}

function renderSourceFields(fields) {
  $("sourceFields").innerHTML = fields.length ? fields.map((field) => `
    <div class="fieldItem">
      <code>${escapeHtml(field.path)}</code>
      <span>${escapeHtml(field.type)} · ${escapeHtml(field.sample)}</span>
    </div>
  `).join("") : `<div class="fieldItem"><span>No fields found in the sample payload.</span></div>`;
}

function dataFieldsFromSnapshot(snapshot) {
  if (!snapshot?.payload || typeof snapshot.payload !== "object") return [];
  return Object.entries(snapshot.payload).map(([key, value]) => ({
    path: `$.${key}`,
    type: Array.isArray(value) ? "array" : typeof value,
    sample: Array.isArray(value) ? `${value.length} items` : typeof value === "object" && value ? `${Object.keys(value).length} fields` : value
  }));
}

function formatRelativeTime(isoTime) {
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return "unknown";
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
  if (deltaSeconds <= 0) return "now";
  if (deltaSeconds < 90) return `in ${deltaSeconds}s`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 90) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `in ${hours}h`;
}

async function publish() {
  await withAction("Publishing dashboard", async () => {
    const definition = parseDefinition();
    await api(`/api/v1/dashboards/${state.dashboardId}`, {
      method: "PATCH",
      body: JSON.stringify({ definition })
    });
    await api(`/api/v1/dashboards/${state.dashboardId}/publish`, { method: "POST" });
    await reloadState("Dashboard revision published.");
  });
}

async function renderCurrent() {
  await withAction("Rendering processed PNG preview", async () => {
    const selectedProfile = profiles[$("profileSelect").value];
    await api(`/api/v1/dashboards/${state.dashboardId}/render`, {
      method: "POST",
      body: JSON.stringify({ profileOverrides: selectedProfile ?? {} })
    });
    await reloadState("Processed e-ink PNG rendered.");
  });
}

async function enroll() {
  await withAction("Enrolling simulator device", async () => {
    const enrollment = await api("/api/v1/devices/enroll", {
      method: "POST",
      body: JSON.stringify({ name: "Browser simulator", capabilities: { profileId: "kindle_basic_600x800" } })
    });
    window.alert(`Device enrolled. Token shown once:\n${enrollment.token}`);
    await reloadState("Simulator device enrolled.");
  });
}

async function createPairing() {
  await withAction("Creating device pairing bundle", async () => {
    const result = await api("/api/v1/devices/pairing-codes", {
      method: "POST",
      body: JSON.stringify({
        name: $("pairDeviceName").value.trim() || "Kindle",
        serverUrl: $("pairServerUrl").value.trim() || window.location.origin,
        capabilities: { profileId: $("pairDeviceProfile").value }
      })
    });
    const href = new URL(result.bundleUrl, window.location.origin).toString();
    $("pairingResult").innerHTML = `
      <div><strong>Code:</strong> ${escapeHtml(result.code)}</div>
      <div><strong>Expires:</strong> ${escapeHtml(result.expiresAt)}</div>
      <a href="${escapeHtml(href)}">Download preconfigured KUAL bundle</a>
    `;
    await reloadState();
    setStatus("Pairing bundle created. Install it under /mnt/us/extensions on the Kindle.");
  });
}

async function assign() {
  await withAction("Assigning dashboard", async () => {
    const deviceId = $("deviceSelect").value;
    await api(`/api/v1/devices/${deviceId}/assign`, {
      method: "POST",
      body: JSON.stringify({ dashboardId: state.dashboardId })
    });
    await reloadState("Dashboard assigned to device.");
  });
}

async function bootstrap() {
  await withAction("Seeding fixture data and rendering dashboards", async () => {
    state.data = await api("/api/v1/bootstrap", { method: "POST" });
    render();
    setStatus("Fixture data seeded and dashboards rendered.");
  });
}

function parseDefinition() {
  try {
    return parseJson($("definition").value, "Dashboard JSON");
  } catch (error) {
    throw new Error(error.message);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

async function withAction(message, action) {
  if (state.busy) return;
  state.busy = true;
  updateButtons();
  setStatus(`${message}...`);
  try {
    await action();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    state.busy = false;
    updateButtons();
  }
}

function updateButtons() {
  const protectedButtons = new Set([
    "bootstrap",
    "refresh",
    "collect",
    "publish",
    "render",
    "enroll",
    "assign",
    "logout",
    "completeSetup",
    "cloneTemplate",
    "runDueSources",
    "testSource",
    "saveSource",
    "createPairing"
  ]);
  for (const button of document.querySelectorAll("button")) {
    button.disabled = state.busy ||
      (protectedButtons.has(button.id) && !state.authenticated) ||
      (button.id === "completeSetup" && Boolean(state.data?.setup?.completed));
  }
}

function updateAuthUi() {
  $("loginForm").hidden = state.authenticated;
  $("logout").hidden = !state.authenticated;
  updateButtons();
}

function setStatus(message, tone = "ok") {
  $("status").textContent = message;
  $("status").className = tone === "error" ? "status error" : "status";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await withAction("Unlocking control plane", async () => {
    await login($("adminToken").value);
    $("adminToken").value = "";
    setStatus("Unlocked.");
  });
});
$("logout").addEventListener("click", logout);
$("refresh").addEventListener("click", refresh);
$("bootstrap").addEventListener("click", bootstrap);
$("completeSetup").addEventListener("click", completeSetup);
$("cloneTemplate").addEventListener("click", cloneTemplate);
$("runDueSources").addEventListener("click", runDueSources);
$("testSource").addEventListener("click", testSource);
$("saveSource").addEventListener("click", saveSource);
$("collect").addEventListener("click", collectAll);
$("publish").addEventListener("click", publish);
$("render").addEventListener("click", renderCurrent);
$("enroll").addEventListener("click", enroll);
$("createPairing").addEventListener("click", createPairing);
$("assign").addEventListener("click", assign);
$("dashboardSelect").addEventListener("change", (event) => {
  state.dashboardId = event.target.value;
  render();
});
$("profileSelect").addEventListener("change", renderCurrent);
$("sourceConnector").addEventListener("change", fillSourceDefaults);

updateAuthUi();
const savedToken = localStorage.getItem("dashboardKindleAdminToken");
if (savedToken) {
  login(savedToken).catch(() => {
    localStorage.removeItem("dashboardKindleAdminToken");
    setStatus("Enter the administrator token to continue.", "error");
  });
} else {
  setStatus("Enter the administrator token to continue.");
}
