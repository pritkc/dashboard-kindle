# Testing

Run:

```bash
pnpm test
pnpm test:golden
pnpm lint
pnpm typecheck
pnpm audit:deps
pnpm scan:secrets
pnpm license:check
pnpm migrate
pnpm build
pnpm container:smoke
```

The tests cover hashing, SSRF protection, quiet-hour scheduling, polling calculations, source collection, render artifacts, ETag behavior, simulator-style image validation, diagnostics, agent fixture output, and backup/restore.

`pnpm test:golden` renders representative dashboards with a pinned render clock and compares the generated PGM pixels against approved references in `tests/golden/approved`. If a comparison fails, the test writes a visual diff PGM to `/tmp`.

After an intentional renderer change, review the output visually and update approved references with:

```bash
UPDATE_GOLDEN=1 pnpm test:golden
```

`pnpm ci:local` runs the local quality gate: linting, syntax checks, dependency inventory, secret scanning, license/runtime pinning checks, SQLite migration verification, unit and E2E tests, golden-image tests, build packaging, and a health smoke test against a temporary server. In GitHub Actions, the same gates run before building the Docker image; the final smoke step starts that image and verifies `/api/v1/health`, administrator protection on `/api/v1/state`, and the root UI route.
