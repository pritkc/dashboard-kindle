# Device Protocol

The primary endpoint is:

```http
GET /api/v1/device/display
Authorization: Bearer <device-token>
If-None-Match: "<current-image-hash>"
```

Changed images return `200 OK`, `Content-Type: image/png`, `ETag`, `X-Next-Poll-Seconds`, `X-Render-ID`, `X-Image-SHA256`, and `X-Full-Refresh`.

Unchanged images return `304 Not Modified` with the same ETag and next-poll hint.

Device tokens are generated with high entropy and stored hashed server-side.
