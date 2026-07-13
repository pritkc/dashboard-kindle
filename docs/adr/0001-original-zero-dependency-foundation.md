# ADR 0001: Original Zero-Dependency Foundation

## Status

Accepted.

## Context

The workspace started with only `init.md`, no package lock, and no existing implementation. The execution environment has Node.js, pnpm, Docker, Playwright CLI, and ImageMagick, but no local TypeScript compiler or installed npm dependencies.

Referenced projects were reviewed as architecture inputs:

* Inker is relevant and current, but the GitHub page describes it as source available rather than a permissive base.
* `usetrmnl/byos_next` and `usetrmnl/byos_node_lite` are MIT-licensed TRMNL BYOS references.
* TRMNL BYOS documents setup, display, and log endpoints.
* CodexBar documents CLI/config-oriented provider usage and cost data.

## Decision

Build an original, self-contained Node.js implementation first. Avoid copying upstream code. Use ImageMagick for deterministic SVG-to-PNG/PGM output. Keep the package shaped like the requested monorepo so the zero-dependency implementation can later be replaced or expanded with NestJS, React, Prisma, and Playwright workers behind the same contracts.

## Consequences

The fixture-backed system runs immediately without downloading dependencies. It does not yet provide full NestJS/React/SQLite parity, but it preserves the core boundaries: connectors, immutable snapshots, dashboard revisions, renderer, e-ink processing, device profiles, scheduling, device protocol, simulator, client package, documentation, and tests.
