# Testing

Run:

```bash
pnpm test
pnpm test:golden
pnpm lint
pnpm typecheck
pnpm build
```

The tests cover hashing, SSRF protection, quiet-hour scheduling, polling calculations, source collection, render artifacts, ETag behavior, simulator-style image validation, diagnostics, agent fixture output, and backup/restore.

`pnpm test:golden` renders representative dashboards with a pinned render clock and compares the generated PGM pixels against approved references in `tests/golden/approved`. If a comparison fails, the test writes a visual diff PGM to `/tmp`.

After an intentional renderer change, review the output visually and update approved references with:

```bash
UPDATE_GOLDEN=1 pnpm test:golden
```
