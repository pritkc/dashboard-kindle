# Backup and Restore

Back up:

```bash
pnpm backup
```

Restore:

```bash
pnpm restore data/backups/<backup>.json
```

Backups include the durable state file. Rendered artifacts can be regenerated from snapshots and dashboard revisions, but keeping `data/artifacts` speeds recovery.
