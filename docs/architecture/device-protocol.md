# Device Protocol

The primary endpoint is:

```http
GET /api/v1/device/display
Authorization: Bearer <device-token>
If-None-Match: "<current-image-hash>"
```

Changed images return `200 OK`, `Content-Type: image/png`, `ETag`, `X-Next-Poll-Seconds`, `X-Render-ID`, `X-Image-SHA256`, and `X-Full-Refresh`.

Unchanged images return `304 Not Modified` with the same ETag and next-poll hint.

When an administrator queues **Refresh at next poll**, the server returns `200 OK` once even if `If-None-Match` matches the current image. That response carries the unchanged image and `X-Full-Refresh: true`, then the command is consumed.

Device tokens are generated with high entropy and stored hashed server-side.
