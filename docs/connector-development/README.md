# Connector Development

A connector manifest defines stable ID, version, display name, execution location, configuration schema, secret fields, output schema version, interval defaults, timeout, and capabilities.

Connectors must return immutable snapshots with deterministic payload hashes. They must redact secrets, enforce timeouts and output limits, and map failures without deleting the previous successful snapshot.

Server HTTP connectors deny loopback, link-local, metadata-service, and private-network targets by default. Private-network access must be explicitly enabled for trusted local deployments.
