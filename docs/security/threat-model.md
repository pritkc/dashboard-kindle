# Threat Model

## Assets

Device tokens, connector secrets, local ActivityWatch/CodexBar data, dashboard definitions, rendered images, and audit logs.

## Controls

* Device tokens are scoped to image delivery and stored hashed.
* Server HTTP connectors block private-network targets by default.
* ActivityWatch and CodexBar are local-agent connectors; fixture mode is used for development.
* Request bodies and connector outputs have size limits.
* Render routes use a restrictive Content Security Policy.
* Errors and diagnostics redact secret-like fields.
* Manifest-declared connector secret fields are encrypted at rest with `DASHBOARD_KINDLE_MASTER_KEY` using authenticated encryption before `data/state.json` is written.

## Remaining Risks

The current zero-dependency state file is not transactional and should move to SQLite with WAL and migrations. Non-secret connector data, dashboard definitions, snapshots, rendered artifacts, and audit logs are still stored as plaintext local files, so filesystem access remains sensitive.
