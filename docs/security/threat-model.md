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

## Remaining Risks

The current zero-dependency state file is not encrypted. Production connector secrets need application-level encryption backed by a master key outside the database before real secrets are stored.
