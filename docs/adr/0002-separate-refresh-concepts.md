# ADR 0002: Separate Refresh Concepts

## Status

Accepted.

## Decision

Dashboard Kindle models refresh as four independent concepts:

1. Connector collection interval: when a source observes upstream data.
2. Dashboard render trigger: when a source or dashboard revision invalidates a render fingerprint.
3. Device polling interval: when a device asks for the current assigned image.
4. Physical panel refresh policy: when the e-ink panel performs a partial or full redraw.

## Rationale

Combining these into one interval wastes power and hides failure modes. A device can poll and receive `304 Not Modified` without forcing a panel redraw. A source can collect without rerendering unrelated dashboards. A render failure can preserve the prior device image.
