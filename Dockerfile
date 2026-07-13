FROM node:26.0.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends imagemagick librsvg2-bin ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

ENV DASHBOARD_KINDLE_HOST=0.0.0.0
ENV DASHBOARD_KINDLE_PORT=8787
ENV DASHBOARD_KINDLE_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -fsS http://127.0.0.1:8787/api/v1/health || exit 1

CMD ["node", "apps/server/src/main.js"]
