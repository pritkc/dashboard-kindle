# Kindle Installation

The KUAL extension is staged by:

```bash
pnpm build
```

Copy `data/artifacts/dashboard-kindle-kual/dashboard-kindle` to `/mnt/us/extensions/dashboard-kindle` on the Kindle. On the device, use the KUAL menu to configure the server URL and device token, then run `Start dashboard` or `Refresh once`.

The client keeps current and previous images, sends `If-None-Match`, validates successful downloads, and uses bounded exponential backoff on failure.
