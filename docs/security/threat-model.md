# Threat Model

## Assets

Device tokens, connector secrets, local ActivityWatch/CodexBar data, dashboard definitions, rendered images, and audit logs.

## Controls

* Device tokens are scoped to image delivery and stored hashed.
* Server HTTP connectors block private-network targets by default.
* ActivityWatch and CodexBar are local-agent connectors; fixture mode is used for development.
* The macOS local agent runs as a user LaunchAgent, does not open an inbound port, and redacts raw ActivityWatch window titles by default.
* Request bodies and connector outputs have size limits.
* Render routes use a restrictive Content Security Policy.
* Errors and diagnostics redact secret-like fields.
* Manifest-declared connector secret fields are encrypted at rest with `DASHBOARD_KINDLE_MASTER_KEY` using authenticated encryption before SQLite state is written.

## Remaining Risks

SQLite uses WAL mode and a schema migration table for the canonical state record. Non-secret connector data, dashboard definitions, snapshots, rendered artifacts, and audit logs are still stored as plaintext local files or SQLite rows, so filesystem access remains sensitive.

Production local collection for ActivityWatch, CodexBar, local files, and local commands still requires tighter allowlist enforcement before it should read private data beyond fixtures.
