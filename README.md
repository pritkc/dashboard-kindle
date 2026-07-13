# Dashboard Kindle

Dashboard Kindle is a self-hosted e-ink dashboard control plane and thin-device client. This repository currently contains a complete fixture-backed vertical slice: sources collect immutable snapshots, dashboards publish immutable revisions, the renderer produces e-ink PNG/PGM artifacts, and devices fetch the assigned image with bearer-token authentication and ETag caching.

## Quick Start

```bash
pnpm seed
pnpm dev
```

Open `http://127.0.0.1:8787`.

Useful commands:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm backup
pnpm agent:dev
pnpm simulator
pnpm docker:up
```

The development UI starts with fixture-backed CodexBar, ActivityWatch, HTTP JSON, and manual sources. No external credentials are required.

For detailed data setup, device enrollment, simulator usage, and Kindle KUAL configuration, see [docs/setup-data-and-device.md](docs/setup-data-and-device.md).

## Device Flow

Enroll a device:

```bash
curl -sS http://127.0.0.1:8787/api/v1/devices/enroll \
  -H 'content-type: application/json' \
  -d '{"name":"Kindle","capabilities":{"profileId":"kindle_basic_600x800"}}'
```

Fetch the assigned image:

```bash
curl -i http://127.0.0.1:8787/api/v1/device/display \
  -H "Authorization: Bearer <device-token>"
```

Run the simulator after the server is started:

```bash
pnpm simulator
```

## Foundation

This is original code. Inker was evaluated as a reference, but its current repository advertises a source-available license, so it is not used as a code base. TRMNL BYOS, `byos_next`, and `byos_node_lite` informed the device/API shape without copying code.

## Current Limits

The app uses a durable JSON state file for the zero-dependency first deployment. `prisma/schema.prisma` documents the planned SQLite migration boundary. Physical Kindle framebuffer behavior is packaged as a KUAL shell client but still requires hardware validation.
