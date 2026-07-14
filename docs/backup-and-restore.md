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

The control-plane UI also has **Backup / Restore** controls. Create a backup, download it, paste backup JSON into the restore box, preview it, then restore. Preview shows dashboard/source/device counts, schema compatibility, artifact-file warnings, and whether connector secret fields are encrypted or plaintext. Encrypted connector secrets require the same `DASHBOARD_KINDLE_MASTER_KEY` used when the backup was created.

Scheduled backups are disabled by default. In **Backup / Restore**, enable **Scheduled backup**, choose an interval in hours, and save. The background scheduler creates the backup when the saved run time is due and then advances the next run by the configured interval. The default interval is 24 hours; override it with `DASHBOARD_KINDLE_BACKUP_INTERVAL_SECONDS`.
