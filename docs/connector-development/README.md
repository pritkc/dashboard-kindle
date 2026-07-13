# Connector Development

A connector manifest defines stable ID, version, display name, execution location, configuration schema, secret fields, output schema version, interval defaults, timeout, and capabilities.

Connectors must return immutable snapshots with deterministic payload hashes. They must redact secrets, enforce timeouts and output limits, and map failures without deleting the previous successful snapshot.

Server HTTP connectors deny loopback, link-local, metadata-service, and private-network targets by default. Private-network access must be explicitly enabled for trusted local deployments.

Built-in server connectors currently include:

* Static manual JSON
* HTTP JSON with optional structured headers/body
* Generic webhook JSON
* RSS/Atom
* Weather through Open-Meteo
* iCalendar URL
* GitHub repository metadata, issues, and pull requests
* Home Assistant entity states

Authenticated HTTP APIs should put credentials in `config.headers` rather than embedding secrets in URLs. Secret-like header names, including `authorization`, are redacted before connector configuration is returned through public state.

The GitHub connector accepts an optional `token` for private repositories or higher rate limits. The token is stored in source configuration but redacted from `/api/v1/state`; avoid putting tokens into dashboard definitions, fixtures, or documentation examples.

The Home Assistant connector uses the official REST API with a Long-Lived Access Token. Because most Home Assistant instances run on a LAN address, `allowPrivateNetwork` must be explicitly set for real local instances. Keep the token in source configuration only; it is redacted from `/api/v1/state`.
