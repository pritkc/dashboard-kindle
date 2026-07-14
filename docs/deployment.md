# Deployment

Start locally:

```bash
brew install imagemagick librsvg   # Linux: apt install imagemagick librsvg2-bin
pnpm check:renderer
pnpm seed && pnpm dev
```

Start with Docker Compose:

```bash
DASHBOARD_KINDLE_ADMIN_TOKEN="$(openssl rand -base64 32)" pnpm docker:up
```

Or write a strong token into `.env` first:

```bash
cp .env.example .env
# edit DASHBOARD_KINDLE_ADMIN_TOKEN before exposing the service on a LAN
pnpm docker:up
```

Persist `/data`. Put the service behind a reverse proxy with HTTPS before exposing it outside a trusted LAN. Device tokens should be rotated if a Kindle is lost or logs are shared.

## Diagnostics

Use the control-plane **Diagnostics** panel to check server health, source failures, scheduler status, device check-ins, storage size, and render artifact counts. **Export JSON** downloads the same redacted diagnostics payload from `/api/v1/diagnostics/export`; it omits raw snapshot payloads and device token hashes.

## macOS Local Agent

The local agent is optional for fixture-backed setup, but it provides the installation path for Mac-local connectors.

```bash
pnpm agent:dev
pnpm agent:install:macos
```

The installer writes `~/Library/LaunchAgents/com.dashboard-kindle.agent.plist`, creates `~/.dashboard-kindle-agent/config.json`, and starts the user service with launchd. Remove only the service with:

```bash
pnpm agent:uninstall:macos
```

Agent configuration and logs are intentionally left in `~/.dashboard-kindle-agent` after uninstall. See [agent.md](agent.md) for privacy controls and allowlist settings.

Run `node apps/agent/src/main.js status` to verify the normalized config, fixture connector availability, and allowlist counts before switching the agent to production local collection.

## Build Artifacts

```bash
pnpm build
```

The build verifies required runtime files and stages two unsigned artifacts under `data/artifacts`:

* `dashboard-kindle-kual`: Kindle KUAL extension directory for jailbroken Kindle installs.
* `dashboard-kindle-local-launcher`: local-agent launcher directory with macOS LaunchAgent install/uninstall scripts and a manifest of reproducible commands.

Signed macOS or Windows installers require signing credentials and installer tooling that are intentionally not stored in this repository.
