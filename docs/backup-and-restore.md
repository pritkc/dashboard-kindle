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

Backup files are pruned after each `pnpm backup` run. The default is to keep the newest 10 files in `data/backups`; override it with `DASHBOARD_KINDLE_BACKUP_LIMIT` or `retention.backupLimit` in state.
