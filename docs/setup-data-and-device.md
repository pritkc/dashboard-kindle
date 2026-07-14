# Setup Data and Devices

This guide covers the fixture-backed setup path, no-code source setup, device pairing, simulator testing, and Kindle KUAL installation. It does not require CodexBar, ActivityWatch, or Kindle hardware unless you choose to test on a physical Kindle.

## 1. Configure Environment

Copy `.env.example` only if you want to override defaults:

```bash
cp .env.example .env
```

Default local values:

* Server: `http://127.0.0.1:8787`
* Local development administrator token: `dev-admin-token`
* Local development master key: `dev-only-change-me`
* Data directory: `./data`
* Fixtures: `data/fixtures`
* Runtime state: `data/state.json`
* Rendered images: `data/artifacts`
* Backup files kept: `10`
* Render artifacts kept per dashboard: `20`

Do not commit `.env`, `data/state.json`, backups, or generated artifacts. They can contain device token hashes, local paths, rendered private dashboard content, or other machine-specific data.

Set `DASHBOARD_KINDLE_MASTER_KEY` to a long random value before storing real connector credentials. The server uses it to encrypt manifest-declared connector secret fields in `data/state.json`; changing or losing it prevents those saved secrets from being decrypted.

Retention defaults can be overridden with `DASHBOARD_KINDLE_BACKUP_LIMIT`, `DASHBOARD_KINDLE_RENDER_ARTIFACT_LIMIT_PER_DASHBOARD`, and `DASHBOARD_KINDLE_SNAPSHOT_HISTORY_LIMIT`.

Install renderer dependencies:

```bash
brew install imagemagick librsvg
```

`librsvg` provides `rsvg-convert`, which ImageMagick uses to render SVG dashboards into PNG artifacts.

## 2. Seed Fixture Data

Run:

```bash
pnpm seed
```

This creates:

* CodexBar fixture snapshot from `data/fixtures/codexbar.json`
* ActivityWatch fixture snapshot from `data/fixtures/activitywatch.json`
* HTTP JSON fixture snapshot from `data/fixtures/http.json`
* Manual/static snapshot
* Initial dashboard revisions
* Render artifacts for the sample dashboards
* A simulator device assignment

## 3. Start the Control Plane

Run:

```bash
pnpm dev
```

Open:

```text
http://127.0.0.1:8787
```

Unlock the UI with `DASHBOARD_KINDLE_ADMIN_TOKEN`. For loopback-only development without `.env`, this is `dev-admin-token`.

The UI opens with a setup checklist. Work through it in this order:

1. Unlock with the administrator token.
2. Confirm the health banner shows the server is reachable.
3. Create or test a data source in **Add Source**.
4. Create a dashboard from **Templates** or use the seeded dashboards.
5. Pair a simulator or physical device.
6. Click **Render** and verify the processed PNG preview appears.
7. Assign the dashboard to the device.
8. Mark setup complete after the preview and device fetch test pass.

The setup status is resumable because the server derives each step from persisted sources, dashboards, devices, assignments, and render artifacts.

The **Diagnostics** panel shows server health, source/device counts, storage use, due jobs, failed sources, and backup schedule state. Use **Export JSON** when you need a redacted support bundle; snapshot history in this export includes hashes and timing metadata but not raw snapshot payloads.

## 4. Add or Test Data Sources

The fixture setup starts with working CodexBar, ActivityWatch, HTTP JSON, and manual sources. To add a new source without editing code:

1. In **Add Source**, pick a connector.
2. Fill the generated configuration fields. Use **Advanced JSON** only when you need to paste a full configuration object or edit nested objects such as HTTP headers.
3. Choose **Update data every**. This controls connector collection only; device polling and panel refresh are separate settings.
4. Click **Test**.
5. Expand the sample payload tree, choose useful fields, and copy the selected paths into dashboard widgets when needed. Examples include `$.metric`, `$.topApplications`, and `$.entities.0.state`.
6. Click **Save**.

Saved sources are collected by a durable scheduler. The source list shows the next scheduled collection and backoff state. **Run due now** executes only jobs whose scheduled time has arrived; **Collect sources** still performs an immediate manual retry of every configured source.

For Mac-local CodexBar and ActivityWatch fixture status, run the local agent in the foreground with `pnpm agent:dev`. To install it as a user LaunchAgent, run `pnpm agent:install:macos`; remove the service with `pnpm agent:uninstall:macos`. See [agent.md](agent.md) before enabling production local collection or command/file allowlists.

Recommended first sources:

* **Static manual data**: use `{ "payload": { "metric": 73, "alert": "All systems nominal" } }`.
* **HTTP JSON**: use `{ "url": "fixture://http" }` for an offline test. For authenticated APIs, add a `headers` object such as `{ "authorization": "Bearer ..." }`; secret-like header values are redacted in public state. For a LAN/private URL, add `"allowPrivateNetwork": true` only when you trust that endpoint.
* **Webhook JSON**: save the generated source, then post JSON to the displayed webhook URL. The server stores the latest payload and redacts the webhook token from public state.
* **RSS or Atom**: use a public feed URL. Private network feed URLs are blocked unless explicitly allowed.
* **Weather**: use `{ "mode": "fixture", "locationName": "San Francisco", "units": "imperial" }` for an offline test, or switch to `"mode": "open-meteo"` and provide `latitude`, `longitude`, and `timezone`.
* **iCalendar URL**: use `{ "url": "fixture://calendar", "maxEvents": 8 }` for an offline test, or provide a public `.ics` URL. Private network calendar URLs are blocked unless explicitly allowed.
* **GitHub repository**: use `{ "mode": "fixture", "includeIssues": true, "includePullRequests": true }` for an offline test. For a real repository, use `{ "mode": "api", "owner": "OWNER", "repo": "REPO", "includeIssues": true, "includePullRequests": true }`. Add `token` only for private repositories or higher rate limits; it is redacted from public state.
* **Home Assistant states**: use `{ "mode": "fixture", "maxEntities": 12 }` for an offline smart-home dashboard. For a real Home Assistant instance, create a Long-Lived Access Token in Home Assistant, then use `{ "mode": "api", "baseUrl": "http://HOME_ASSISTANT_IP:8123", "token": "TOKEN", "entityIds": ["sensor.living_room_temperature", "lock.front_door"], "allowPrivateNetwork": true }`. Only enable private-network access for a Home Assistant server you control.

## 5. Create a Dashboard

Use **Templates** in the UI for a no-code start. Current templates include blank, clock/status, work/activity, news/RSS, clock/weather, calendar-day, GitHub status, and Home Assistant status layouts. After creating a dashboard:

1. Select it in the dashboard dropdown.
2. Use **Widget Builder** to choose a widget and edit title, source, field path, type, size, and position.
3. Check the layout status for overlap or out-of-bounds warnings.
4. Click **Publish revision** when the draft is ready.
5. Click **Render** to generate the processed PNG preview.
6. Assign it to a device in **Device assignment**.

The raw JSON editor remains available under **Advanced dashboard JSON** for bulk edits and fields that do not yet have visual controls. Publish explicitly after editing JSON.

## 6. Manage Dashboards

Use **Dashboard Management** in the sidebar for the selected dashboard:

* **Rename**: changes the dashboard name shown in lists and device assignment controls.
* **Duplicate**: creates a new editable copy and selects it.
* **Archive/Restore**: hides old dashboards from active use without deleting revision history.
* **Delete**: removes the dashboard, its revisions, and render artifacts. The server blocks deletion if the dashboard is currently assigned to a device or if it is the last dashboard.
* **Export**: writes portable dashboard JSON into the import/export text area.
* **Import**: creates a new dashboard from exported JSON or a raw dashboard definition.

Exported JSON contains the declarative dashboard definition only. It does not include snapshots, rendered images, device tokens, or connector secrets.

## 7. Pair a Device

### UI pairing path

Use **Pair Device** in the sidebar:

1. Enter a device name.
2. Select the closest screen profile.
3. Review the compatibility panel. Kindle profiles require jailbreak and KUAL before the generated bundle can run; simulator/BYOD profiles do not.
4. Set `Server URL` to the LAN address reachable from the device, for example `http://192.168.1.20:8787`.
5. Click **Create pairing bundle**.
6. Download the generated `dashboard-kindle-<code>.tgz`.

The bundle contains the KUAL extension plus a prefilled `state/config` file with `SERVER_URL`, `DEVICE_TOKEN`, and `POLL_SECONDS`. The pairing code expires after 15 minutes. The device token is stored hashed on the server and is not exposed through `/api/v1/state`.

### API pairing path

For scripted setup:

```bash
curl -sS http://127.0.0.1:8787/api/v1/devices/pairing-codes \
  -H "X-Admin-Token: <admin-token>" \
  -H 'content-type: application/json' \
  -d '{"name":"Kindle","serverUrl":"http://<server-lan-ip>:8787","capabilities":{"profileId":"kindle_basic_600x800","width":600,"height":800}}'
```

Download the returned `bundleUrl` and unpack it onto the device.

Direct enrollment is still available for simulator or advanced testing:

```bash
curl -sS http://127.0.0.1:8787/api/v1/devices/enroll \
  -H "X-Admin-Token: <admin-token>" \
  -H 'content-type: application/json' \
  -d '{"name":"Kindle","capabilities":{"profileId":"kindle_basic_600x800","width":600,"height":800}}'
```

The direct enrollment response includes a `token` once. Store it on the device. The server stores only a token hash.

Assign a dashboard:

```bash
curl -sS http://127.0.0.1:8787/api/v1/devices/<device-id>/assign \
  -H "X-Admin-Token: <admin-token>" \
  -H 'content-type: application/json' \
  -d '{"dashboardId":"work"}'
```

Fetch the display image:

```bash
curl -i http://127.0.0.1:8787/api/v1/device/display \
  -H "Authorization: Bearer <device-token>"
```

Fetch again with the returned ETag to verify unchanged images:

```bash
curl -i http://127.0.0.1:8787/api/v1/device/display \
  -H "Authorization: Bearer <device-token>" \
  -H 'If-None-Match: "<etag-value>"'
```

Expected result for an unchanged non-clock dashboard is `304 Not Modified`.

## 8. Manage Devices and Refresh Behavior

Use **Device Management** in the sidebar after enrolling or pairing a device.

The page shows:

* Online/offline or revoked state
* Last check-in
* Assigned dashboard
* Current image hash
* Last successful refresh
* Next poll
* Screen profile
* Pending refresh command
* Token status

Available actions:

* **Save policy**: applies a refresh preset or custom values.
* **Refresh at next poll**: queues a one-time redraw. If the image hash is unchanged, the server still returns `200 OK` once with `X-Full-Refresh: true`; later unchanged polls return `304 Not Modified` again.
* **Rotate token**: creates a new device token and invalidates the old token. The new token is shown once.
* **Revoke**: disables image delivery for that device until a token is rotated.

Refresh concepts are intentionally separate:

* **Update data every**: source connector collection interval.
* **Rebuild screen when**: manual render/publish action in this build; automatic render triggers remain a planned improvement.
* **Device checks for updates every**: device polling interval.
* **Full screen cleanup every**: physical panel full-refresh cadence, measured in changed-image deliveries.

Presets:

| Preset | Device checks | Full cleanup | Quiet hours |
| --- | --- | --- | --- |
| Battery Saver | Up to every 30 minutes | Every 24 changed images | 22:00-07:00 |
| Balanced | Up to every 5 minutes | Every 8 changed images | Off |
| Near Real-Time | Up to every 1 minute | Every 4 changed images | Off |
| Custom | User-selected | User-selected | User-selected |

## 9. Back Up and Restore

Use **Backup / Restore** in the UI to create a downloadable state backup. To restore, paste backup JSON into the restore box, click **Preview restore**, review schema, device, artifact, and connector-secret warnings, then click **Restore**.

To automate backups, enable **Scheduled backup**, choose the interval in hours, and save. **Run due** creates a scheduled backup only when the saved next-run time is due. Use `DASHBOARD_KINDLE_BACKUP_INTERVAL_SECONDS` to change the default 24-hour interval for new schedules.

CLI backup and restore are also available:

```bash
pnpm backup
pnpm restore data/backups/<backup>.json
```

Keep `DASHBOARD_KINDLE_MASTER_KEY` stable across backups if connector secrets are stored.

## 10. Use the Simulator

With the server running:

```bash
pnpm simulator
```

The simulator enrolls itself when no `DASHBOARD_KINDLE_DEVICE_TOKEN` is set, downloads the assigned PNG, validates the PNG signature, validates `X-Image-SHA256`, stores the image under `data/artifacts/simulator`, and writes the latest ETag. Enrollment requires the admin token:

```bash
DASHBOARD_KINDLE_ADMIN_TOKEN=<admin-token> pnpm simulator
```

To reuse an existing token:

```bash
DASHBOARD_KINDLE_DEVICE_TOKEN=<device-token> pnpm simulator
```

## 11. Kindle Compatibility

Dashboard Kindle’s physical client is a KUAL extension. A stock Kindle cannot run it until the device has a jailbreak and KUAL installed.
The **Pair Device** panel shows these same warnings before it creates a bundle.

| Device class | Status | Notes |
| --- | --- | --- |
| Kindle Basic 600x800 | Supported profile, hardware validation still required | Use `kindle_basic_600x800`. |
| Kindle Paperwhite 758x1024 | Supported profile, hardware validation still required | Use `kindle_pw_758x1024`. |
| TRMNL/BYOD 800x480 | Supported generic profile for simulator/BYOD clients | Use `trmnl_800x480`. |
| Other e-ink screens | Custom profile required | Set width, height, palette, dithering, and refresh policy manually in advanced state for now. |
| Unsupported stock Kindle firmware | Not no-code | Jailbreak/KUAL availability depends on model and firmware. Verify this before buying hardware. |

Known current limitations:

* Sleep/wake behavior depends on the Kindle model, firmware, and available display tools.
* The server/device protocol is tested in simulator and with generated KUAL packages; physical framebuffer behavior still needs hardware validation.
* Keep the server on a trusted LAN or behind HTTPS. Do not expose port `8787` directly to the public internet.

## 12. Configure Kindle KUAL Client

Build the package:

```bash
pnpm build
```

Copy the staged extension from:

```text
data/artifacts/dashboard-kindle-kual/dashboard-kindle
```

to:

```text
/mnt/us/extensions/dashboard-kindle
```

On the Kindle, run `Re-enroll / configure` from KUAL and set:

```sh
SERVER_URL=http://<server-lan-ip>:8787
DEVICE_TOKEN=<device-token>
POLL_SECONDS=300
```

Then run `Refresh once` to test a single download, followed by `Start dashboard` for polling mode.

If you used the UI pairing bundle, unpack the downloaded archive and copy its `dashboard-kindle` directory to `/mnt/us/extensions/dashboard-kindle`; the config file is already filled in.

## 13. Reset Local Runtime Data

Stop the server, then remove runtime files:

```bash
rm -rf data/state.json data/artifacts data/backups
pnpm seed
```

This preserves source files and fixtures while regenerating local state.
