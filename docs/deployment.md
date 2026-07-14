# Deployment

Start locally:

```bash
pnpm seed
pnpm dev
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
