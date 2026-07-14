# Dashboard Kindle

Dashboard Kindle is a self-hosted e-ink dashboard control plane and thin-device client. This repository currently contains a complete fixture-backed vertical slice: sources collect immutable snapshots, dashboards publish immutable revisions, the renderer produces e-ink PNG/PGM artifacts, and devices fetch the assigned image with bearer-token authentication and ETag caching.

## Quick Start

Requires Node 22+, pnpm 10, and renderer tools (`imagemagick`, `librsvg`).

```bash
brew install imagemagick librsvg   # Linux: apt install imagemagick librsvg2-bin
pnpm check:renderer
pnpm seed && pnpm dev
```

Open `http://127.0.0.1:8787` and unlock with `dev-admin-token`.

`pnpm seed` checks renderer tools automatically. `rsvg-convert` renders dashboard SVG text; ImageMagick applies grayscale, palette, and PGM conversion.

### LAN access for Kindle

By default the server binds to `127.0.0.1`, so phones/Kindles on your Wi‑Fi cannot reach it. For LAN access:

```bash
cp .env.example .env
# set DASHBOARD_KINDLE_HOST=0.0.0.0
# set a strong DASHBOARD_KINDLE_ADMIN_TOKEN (required when not on loopback)
pnpm seed && pnpm dev
```

Then check from this Mac:

```bash
curl -sS http://$(ipconfig getifaddr en0):8787/api/v1/health
```

Use that same LAN URL (for example `http://192.168.1.140:8787`) in the UI **Pair Device** Server URL field. Unlock the browser UI with the token from `.env`, not `dev-admin-token`.

Useful commands:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm ci:local
pnpm migrate
pnpm build
pnpm backup
pnpm agent:dev
pnpm agent:install:macos
pnpm simulator
pnpm docker:up
```

The development UI starts with fixture-backed CodexBar, ActivityWatch, HTTP JSON, and manual sources. No external credentials are required.

For guided setup, data-source configuration, device pairing, simulator usage, and Kindle KUAL installation, see [docs/setup-data-and-device.md](docs/setup-data-and-device.md).

For Mac-local CodexBar and ActivityWatch fixture collection, see [docs/agent.md](docs/agent.md). `pnpm agent:install:macos` installs a user LaunchAgent and `pnpm agent:uninstall:macos` removes it. `pnpm build` also stages an unsigned local launcher under `data/artifacts/dashboard-kindle-local-launcher`; signed desktop installers require external signing credentials.

## Device Flow

Enroll a device:

```bash
curl -sS http://127.0.0.1:8787/api/v1/devices/enroll \
  -H "X-Admin-Token: <admin-token>" \
  -H 'content-type: application/json' \
  -d '{"name":"Kindle","capabilities":{"profileId":"kindle_basic_600x800"}}'
```

The browser UI also provides a no-code pairing path: choose a device model, enter the LAN server URL, and download a preconfigured KUAL bundle.

Fetch the assigned image:

```bash
curl -i http://127.0.0.1:8787/api/v1/device/display \
  -H "Authorization: Bearer <device-token>"
```

Run the simulator after the server is started:

```bash
DASHBOARD_KINDLE_ADMIN_TOKEN=<admin-token> pnpm simulator
```

## Foundation

This is original code. Inker was evaluated as a reference, but its current repository advertises a source-available license, so it is not used as a code base. TRMNL BYOS, `byos_next`, and `byos_node_lite` informed the device/API shape without copying code.

## Current Limits

The app stores runtime state in `data/dashboard-kindle.sqlite` with SQLite WAL mode. If an older `data/state.json` exists, the first migration imports it into SQLite and writes a timestamped import backup under `data/backups`. Physical Kindle framebuffer behavior is packaged as a KUAL shell client but still requires hardware validation.
