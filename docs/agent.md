# Local Agent

The local agent is an outbound-only helper for Mac-local data that should not be exposed through the server, such as CodexBar and ActivityWatch. The current implementation runs in fixture mode by default and emits a privacy-safe status snapshot without raw ActivityWatch window titles.

Run once in the foreground:

```bash
pnpm agent:dev
```

Check normalized configuration and fixture connector status:

```bash
node apps/agent/src/main.js status
```

Install as a macOS LaunchAgent:

```bash
pnpm agent:install:macos
```

This creates:

* `~/Library/LaunchAgents/com.dashboard-kindle.agent.plist`
* `~/.dashboard-kindle-agent/config.json`
* `~/.dashboard-kindle-agent/logs/agent.out.log`
* `~/.dashboard-kindle-agent/logs/agent.err.log`

Uninstall the LaunchAgent:

```bash
pnpm agent:uninstall:macos
```

Uninstalling leaves `~/.dashboard-kindle-agent` in place so allowlists and logs are not deleted unexpectedly.

## Configuration

The default config is:

```json
{
  "mode": "fixture",
  "serverUrl": "http://127.0.0.1:8787",
  "redactActivityWatchWindowTitles": true,
  "allowlists": {
    "commands": [],
    "files": []
  },
  "disabledConnectors": []
}
```

Keep `redactActivityWatchWindowTitles` enabled unless you explicitly need raw titles for a private local dashboard. Command and file connectors must be allowlisted before production local collection is enabled.

Allowlist entries are exact strings after normalization. Add only commands and files that the dashboard needs, and prefer stable absolute paths:

```json
{
  "allowlists": {
    "commands": ["/usr/bin/uptime"],
    "files": ["/Users/you/.dashboard-kindle/status.json"]
  }
}
```

`disabledConnectors` accepts connector IDs such as `codexbar.usage` or `activitywatch.summary`. The status command reports allowlist counts and whether fixture-backed local connectors are available; it does not print raw ActivityWatch window titles.

## LaunchAgent Behavior

The installed service runs:

```bash
node apps/agent/src/main.js daemon
```

It writes fixture-safe status snapshots to the agent log directory at a regular interval. It does not open an inbound network port.

## Unsigned Launcher Artifact

`pnpm build` stages an unsigned local launcher at `data/artifacts/dashboard-kindle-local-launcher`. It contains the agent entrypoint, macOS install/uninstall scripts, documentation, and a `manifest.json` with reproducible commands. Signed macOS or Windows installers are not produced by this repository because code-signing credentials are not present.
