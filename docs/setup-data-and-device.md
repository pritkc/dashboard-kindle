# Setup Data and Devices

This guide covers the fixture-backed setup path and the device setup path. It does not require CodexBar, ActivityWatch, or Kindle hardware.

## 1. Configure Environment

Copy `.env.example` only if you want to override defaults:

```bash
cp .env.example .env
```

Default local values:

* Server: `http://127.0.0.1:8787`
* Local development administrator token: `dev-admin-token`
* Data directory: `./data`
* Fixtures: `data/fixtures`
* Runtime state: `data/state.json`
* Rendered images: `data/artifacts`

Do not commit `.env`, `data/state.json`, backups, or generated artifacts. They can contain device token hashes, local paths, rendered private dashboard content, or other machine-specific data.

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

The UI lets you collect sources, edit dashboard JSON, publish a revision, render, enroll a simulator device, and assign dashboards to devices.

## 4. Enroll a Device

Use the API:

```bash
curl -sS http://127.0.0.1:8787/api/v1/devices/enroll \
  -H "X-Admin-Token: <admin-token>" \
  -H 'content-type: application/json' \
  -d '{"name":"Kindle","capabilities":{"profileId":"kindle_basic_600x800","width":600,"height":800}}'
```

The response includes a `token` once. Store it on the device. The server stores only a token hash.

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

## 5. Use the Simulator

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

## 6. Configure Kindle KUAL Client

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

## 7. Reset Local Runtime Data

Stop the server, then remove runtime files:

```bash
rm -rf data/state.json data/artifacts data/backups
pnpm seed
```

This preserves source files and fixtures while regenerating local state.
