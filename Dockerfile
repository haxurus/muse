FROM node:22-bookworm-slim AS base

ARG YT_DLP_VERSION=
ENV MUSE_BUNDLED_YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
    ffmpeg \
    tini \
    openssl \
    ca-certificates \
    python3 \
    python3-venv \
    && python3 -m venv /opt/yt-dlp \
    && if [ -n "${YT_DLP_VERSION}" ]; then \
        /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]==${YT_DLP_VERSION}"; \
    else \
        /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]"; \
    fi \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies

WORKDIR /usr/app

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
    python-is-python3 \
    build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --prod \
    && cp -R node_modules /usr/app/prod_node_modules \
    && yarn install --frozen-lockfile

FROM dependencies AS builder

COPY . .
RUN yarn prisma generate
RUN yarn build

FROM base AS runner

WORKDIR /usr/app

ARG COMMIT_HASH=unknown
ARG BUILD_DATE=unknown

ENV DATA_DIR=/data \
    NODE_ENV=production \
    COMMIT_HASH=${COMMIT_HASH} \
    BUILD_DATE=${BUILD_DATE} \
    ENV_FILE=/config \
    MUSE_READY_FILE=/tmp/muse-ready \
    YT_DLP_AUTO_UPDATE=false

COPY --from=builder --chown=node:node /usr/app/dist ./dist
COPY --from=dependencies --chown=node:node /usr/app/prod_node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/app/node_modules/.prisma/client ./node_modules/.prisma/client
COPY --from=builder --chown=node:node /usr/app/migrations ./migrations
COPY --from=builder --chown=node:node /usr/app/schema.prisma ./schema.prisma
COPY --from=builder --chown=node:node /usr/app/package.json ./package.json

RUN mkdir -p /data && chown node:node /data

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=45s --retries=3 \
  CMD test -f /tmp/muse-ready || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "--enable-source-maps", "dist/scripts/migrate-and-start.js"]
