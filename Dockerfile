# Base image pinned by multi-arch index digest; Dependabot (docker ecosystem) proposes updates.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS base

# yt-dlp is installed from a hash-locked requirements file. The ARG documents the
# locked release and is cross-checked against the lock and the installed binary.
# Bump both together with .github/scripts/yt-dlp-lock.py (the yt-dlp refresh
# workflow opens a pull request doing exactly that).
ARG YT_DLP_VERSION=2026.08.19
# PO token provider plugin, hash-locked in its own file (the refresh workflow
# regenerates only the yt-dlp lock). It must match the pot-provider image
# version in deploy/docker-compose.prod.yml; bump all three together.
ARG BGUTIL_POT_VERSION=2.0.2
ENV MUSE_BUNDLED_YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp \
    CHECKPOINT_DISABLE=1

COPY deploy/yt-dlp-requirements.txt /tmp/yt-dlp-requirements.txt
COPY deploy/yt-dlp-plugins-requirements.txt /tmp/yt-dlp-plugins-requirements.txt

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
    ffmpeg \
    tini \
    openssl \
    ca-certificates \
    python3 \
    python3-venv \
    && grep -Fqx "yt-dlp[default]==${YT_DLP_VERSION} \\" /tmp/yt-dlp-requirements.txt \
    && grep -Fqx "bgutil-ytdlp-pot-provider==${BGUTIL_POT_VERSION} \\" /tmp/yt-dlp-plugins-requirements.txt \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --disable-pip-version-check \
        --require-hashes --only-binary=:all: \
        -r /tmp/yt-dlp-requirements.txt -r /tmp/yt-dlp-plugins-requirements.txt \
    && test "$(/opt/yt-dlp/bin/yt-dlp --version)" = "${YT_DLP_VERSION}" \
    && /opt/yt-dlp/bin/python -c "import yt_dlp_plugins.extractor.getpot_bgutil_http" \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && rm -f /tmp/yt-dlp-requirements.txt /tmp/yt-dlp-plugins-requirements.txt \
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

RUN groupadd --system --gid 10001 muse \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin muse

ARG COMMIT_HASH=unknown
ARG BUILD_DATE=unknown

ENV DATA_DIR=/data \
    NODE_ENV=production \
    COMMIT_HASH=${COMMIT_HASH} \
    BUILD_DATE=${BUILD_DATE} \
    ENV_FILE=/config \
    MUSE_READY_FILE=/tmp/muse-ready \
    YT_DLP_AUTO_UPDATE=false \
    CHECKPOINT_DISABLE=1

# Application code is root-owned and therefore read-only for the runtime user.
# Only /data (a volume in production) is owned by uid 10001.
COPY --from=builder /usr/app/dist ./dist
COPY --from=builder /usr/app/dashboard ./dashboard
COPY --from=dependencies /usr/app/prod_node_modules ./node_modules
COPY --from=builder /usr/app/node_modules/.prisma/client ./node_modules/.prisma/client
COPY --from=builder /usr/app/migrations ./migrations
COPY --from=builder /usr/app/schema.prisma ./schema.prisma
COPY --from=builder /usr/app/package.json ./package.json

# Deployment bundle: muse-deploy extracts these root-owned files from the exact
# image digest it deploys, so the VPS Compose project always matches the release.
COPY deploy/docker-compose.prod.yml \
     deploy/workers.json \
     deploy/docker-compose.bot-one-playback.yml \
     deploy/docker-compose.bot-two-playback.yml \
     deploy/docker-compose.bot-three-playback.yml \
     deploy/docker-compose.bot-four-playback.yml \
     deploy/docker-compose.bot-five-playback.yml \
     /opt/muse-deploy/

RUN chmod 0755 /opt/muse-deploy \
    && chmod 0444 /opt/muse-deploy/* \
    && mkdir -p /data \
    && chown 10001:10001 /data

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=3s --start-period=45s --retries=3 \
  CMD test -f /tmp/muse-ready || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "--enable-source-maps", "dist/scripts/migrate-and-start.js"]
