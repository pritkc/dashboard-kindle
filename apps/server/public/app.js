const state = {
  data: null,
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
  state.data = await api("/api/v1/state");
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
    state.data = await api("/api/v1/state");
    state.authenticated = true;
    updateAuthUi();
    render();
    setStatus("State refreshed.");
  });
}

function render() {
  if (!state.data) return;
  const dashboards = state.data.dashboards;
  if (!dashboards.find((dashboard) => dashboard.id === state.dashboardId)) {
    state.dashboardId = dashboards[0]?.id;
  }
  renderDashboardList();
  renderSources();
  renderDevices();
  renderSelects();
  renderInspector();
  renderPreview();
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

function renderSources() {
  $("sources").innerHTML = state.data.connectorInstances.map((source) => {
    const health = state.data.sourceHealth[source.id];
    const snapshot = state.data.snapshots[source.id];
    return `<div class="item">
      <strong>${escapeHtml(source.name)}</strong>
      <span>${escapeHtml(source.connectorId)} · ${escapeHtml(health?.state ?? "not collected")}</span>
      <span>${escapeHtml(snapshot?.payloadHash?.slice(0, 12) ?? "no snapshot")}</span>
    </div>`;
  }).join("");
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
    await refresh();
    setStatus("Sources collected.");
  });
}

async function publish() {
  await withAction("Publishing dashboard", async () => {
    const definition = parseDefinition();
    await api(`/api/v1/dashboards/${state.dashboardId}`, {
      method: "PATCH",
      body: JSON.stringify({ definition })
    });
    await api(`/api/v1/dashboards/${state.dashboardId}/publish`, { method: "POST" });
    await refresh();
    setStatus("Dashboard revision published.");
  });
}

async function renderCurrent() {
  await withAction("Rendering processed PNG preview", async () => {
    const selectedProfile = profiles[$("profileSelect").value];
    await api(`/api/v1/dashboards/${state.dashboardId}/render`, {
      method: "POST",
      body: JSON.stringify({ profileOverrides: selectedProfile ?? {} })
    });
    await refresh();
    setStatus("Processed e-ink PNG rendered.");
  });
}

async function enroll() {
  await withAction("Enrolling simulator device", async () => {
    const enrollment = await api("/api/v1/devices/enroll", {
      method: "POST",
      body: JSON.stringify({ name: "Browser simulator", capabilities: { profileId: "kindle_basic_600x800" } })
    });
    window.alert(`Device enrolled. Token shown once:\n${enrollment.token}`);
    await refresh();
    setStatus("Simulator device enrolled.");
  });
}

async function assign() {
  await withAction("Assigning dashboard", async () => {
    const deviceId = $("deviceSelect").value;
    await api(`/api/v1/devices/${deviceId}/assign`, {
      method: "POST",
      body: JSON.stringify({ dashboardId: state.dashboardId })
    });
    await refresh();
    setStatus("Dashboard assigned to device.");
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
    return JSON.parse($("definition").value);
  } catch (error) {
    throw new Error(`Dashboard JSON is invalid: ${error.message}`);
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
  const protectedButtons = new Set(["bootstrap", "refresh", "collect", "publish", "render", "enroll", "assign", "logout"]);
  for (const button of document.querySelectorAll("button")) {
    button.disabled = state.busy || (protectedButtons.has(button.id) && !state.authenticated);
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
$("collect").addEventListener("click", collectAll);
$("publish").addEventListener("click", publish);
$("render").addEventListener("click", renderCurrent);
$("enroll").addEventListener("click", enroll);
$("assign").addEventListener("click", assign);
$("dashboardSelect").addEventListener("change", (event) => {
  state.dashboardId = event.target.value;
  render();
});
$("profileSelect").addEventListener("change", renderCurrent);

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
