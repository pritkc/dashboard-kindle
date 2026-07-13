# Deployment

Start locally:

```bash
pnpm seed
pnpm dev
```

Start with Docker Compose:

```bash
pnpm docker:up
```

Persist `/data`. Put the service behind a reverse proxy with HTTPS before exposing it outside a trusted LAN. Device tokens should be rotated if a Kindle is lost or logs are shared.
