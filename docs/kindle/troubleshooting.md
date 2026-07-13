# Kindle Troubleshooting

Logs are written under the extension `state/client.log` path. If a fetch fails, the client keeps the previous displayed image.

Firmware display tooling varies. The script attempts `eips` first and logs when image display support is unavailable. A native framebuffer helper should be added only for models where `eips -g` is insufficient.
