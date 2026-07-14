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

`tests/ui-flow.test.js` is a zero-dependency browser-surface contract test. It verifies that the committed HTML and JavaScript still expose and wire the controls used by the no-code setup, source creation, dashboard editing/publish, device pairing, backup/restore, and diagnostics flows. It does not replace rendered browser QA; use the manual checklist below for that.

`pnpm test:golden` renders representative dashboards with a pinned render clock and compares the generated PGM pixels against approved references in `tests/golden/approved`. If a comparison fails, the test writes a visual diff PGM to `/tmp`.

After an intentional renderer change, review the output visually and update approved references with:

```bash
UPDATE_GOLDEN=1 pnpm test:golden
```

`pnpm ci:local` runs the local quality gate: linting, syntax checks, dependency inventory, secret scanning, license/runtime pinning checks, SQLite migration verification, unit and E2E tests, golden-image tests, build packaging, and a health smoke test against a temporary server. In GitHub Actions, the same gates run before building the Docker image; the final smoke step starts that image and verifies `/api/v1/health`, administrator protection on `/api/v1/state`, and the root UI route.

## Manual Browser E2E Checklist

After a major UI, renderer, storage, or device-protocol change:

1. Start with a clean or temporary `DASHBOARD_KINDLE_DATA_DIR`.
2. Run `pnpm seed`, then start the server with `pnpm dev`.
3. Open `http://127.0.0.1:8787` and unlock with the administrator token.
4. Verify the setup checklist, diagnostics, source list, dashboard list, rendered preview, and processed PNG preview are visible.
5. Test a source with fixture data, save it, publish the selected dashboard, and render it.
6. Create a pairing bundle or enroll a simulator device, assign a dashboard, fetch the display image, and verify a second fetch returns `304 Not Modified`.
7. Create a backup, preview restore JSON, and confirm diagnostics export downloads redacted JSON.
8. Check browser console errors/warnings and capture desktop plus mobile screenshots when layout changed.
