const state = {
  data: null,
  dashboardId: "work"
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function refresh() {
  state.data = await api("/api/v1/state");
  if (!state.data.dashboards.length) {
    state.data = await api("/api/v1/bootstrap", { method: "POST" });
  }
  render();
}

function render() {
  const dashboards = state.data.dashboards;
  if (!dashboards.find((dashboard) => dashboard.id === state.dashboardId)) {
    state.dashboardId = dashboards[0]?.id;
  }
  renderDashboardList();
  renderSources();
  renderDevices();
  renderSelects();
  renderInspector();
  $("preview").src = `/render/${state.dashboardId}?cache=${Date.now()}`;
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
    return `<div class="item">
      <strong>${escapeHtml(device.name)}</strong>
      <span>${escapeHtml(device.profile.name)} · ${escapeHtml(assignment?.dashboardId ?? "unassigned")}</span>
    </div>`;
  }).join("");
}

function renderSelects() {
  $("dashboardSelect").innerHTML = state.data.dashboards.map((dashboard) => `<option value="${dashboard.id}">${escapeHtml(dashboard.name)}</option>`).join("");
  $("dashboardSelect").value = state.dashboardId;
  $("deviceSelect").innerHTML = state.data.devices.map((device) => `<option value="${device.id}">${escapeHtml(device.name)}</option>`).join("");
  const dashboard = state.data.dashboards.find((item) => item.id === state.dashboardId);
  $("definition").value = JSON.stringify(dashboard?.draft ?? {}, null, 2);
}

function renderInspector() {
  const dashboard = state.data.dashboards.find((item) => item.id === state.dashboardId);
  const revisions = state.data.dashboardRevisions.filter((revision) => revision.dashboardId === state.dashboardId);
  const artifact = [...state.data.renderArtifacts].reverse().find((item) => item.dashboardId === state.dashboardId);
  $("inspector").innerHTML = dl({
    "Dashboard": dashboard?.name,
    "Revision": dashboard?.currentRevisionId,
    "Revision count": revisions.length,
    "Widgets": dashboard?.draft?.widgets?.length ?? 0,
    "Profile": `${dashboard?.draft?.profile?.width}x${dashboard?.draft?.profile?.height}`
  });
  $("artifact").textContent = artifact ? JSON.stringify({
    id: artifact.id,
    imageHash: artifact.imageHash,
    bytes: artifact.bytes,
    imagePath: artifact.imagePath,
    pgmPath: artifact.pgmPath
  }, null, 2) : "No render yet.";
}

function dl(values) {
  return Object.entries(values).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value ?? "")}</dd>`).join("");
}

async function collectAll() {
  for (const source of state.data.connectorInstances) {
    await api(`/api/v1/sources/${source.id}/collect`, { method: "POST" });
  }
  await refresh();
}

async function publish() {
  const definition = JSON.parse($("definition").value);
  await api(`/api/v1/dashboards/${state.dashboardId}`, {
    method: "PATCH",
    body: JSON.stringify({ definition })
  });
  await api(`/api/v1/dashboards/${state.dashboardId}/publish`, { method: "POST" });
  await refresh();
}

async function renderCurrent() {
  await api(`/api/v1/dashboards/${state.dashboardId}/render`, { method: "POST" });
  await refresh();
}

async function enroll() {
  const enrollment = await api("/api/v1/devices/enroll", {
    method: "POST",
    body: JSON.stringify({ name: "Browser simulator", capabilities: { profileId: "kindle_basic_600x800" } })
  });
  window.alert(`Device enrolled. Token shown once:\n${enrollment.token}`);
  await refresh();
}

async function assign() {
  const deviceId = $("deviceSelect").value;
  await api(`/api/v1/devices/${deviceId}/assign`, {
    method: "POST",
    body: JSON.stringify({ dashboardId: state.dashboardId })
  });
  await refresh();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

$("refresh").addEventListener("click", refresh);
$("bootstrap").addEventListener("click", async () => {
  state.data = await api("/api/v1/bootstrap", { method: "POST" });
  render();
});
$("collect").addEventListener("click", collectAll);
$("publish").addEventListener("click", publish);
$("render").addEventListener("click", renderCurrent);
$("enroll").addEventListener("click", enroll);
$("assign").addEventListener("click", assign);
$("dashboardSelect").addEventListener("change", (event) => {
  state.dashboardId = event.target.value;
  render();
});

refresh().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.stack ?? error.message)}</pre>`;
});
