# Deployment

Start locally:

```bash
pnpm seed
pnpm dev
```

Start with Docker Compose:

```bash
DASHBOARD_KINDLE_ADMIN_TOKEN="$(openssl rand -base64 32)" pnpm docker:up
```

Or write a strong token into `.env` first:

```bash
cp .env.example .env
# edit DASHBOARD_KINDLE_ADMIN_TOKEN before exposing the service on a LAN
pnpm docker:up
```

Persist `/data`. Put the service behind a reverse proxy with HTTPS before exposing it outside a trusted LAN. Device tokens should be rotated if a Kindle is lost or logs are shared.
