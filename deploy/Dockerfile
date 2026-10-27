# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /source
COPY . .
# Keep the dependency tree and compiler scratch in RAM, rather than retaining
# gigabytes of intermediate layers on the VPS root filesystem.
RUN --mount=type=tmpfs,target=/work \
    cp -a /source/. /work/ && cd /work && \
    printf '[image] 0%% (0/3) Installing locked dependencies\n' && \
    npm ci --ignore-scripts --no-audit --no-fund --cache /work/.npm-cache && \
    printf '[image] 33%% (1/3) Building production app\n' && \
    LH_WEB_HOSTED=1 npm run build && \
    printf '[image] 67%% (2/3) Curating standalone runtime\n' && \
    node scripts/build-server.mjs && \
    cp -a .next/standalone /payload && \
    printf '[image] 100%% (3/3) Application payload ready\n'

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/node/learner /app/.next/cache \
    && chown -R node:node /home/node/learner /app
WORKDIR /app
COPY --from=build --chown=node:node /payload/ ./
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 CHROME_PATH=/usr/bin/chromium
USER node
EXPOSE 3000
CMD ["node", "server.js"]
