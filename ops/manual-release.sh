#!/bin/bash
# Manual release: the fallback when GitHub Actions cannot build images.
#
# Run as root from a fresh clone of main, after `docker login ghcr.io` with a
# token that has write:packages. Mirrors CI and the "Deploy production" build:
#   1. lint, typecheck, tests and TypeScript build (inside the image's own
#      builder stage, so the toolchain matches the release)
#   2. Compose validation with placeholder secrets
#   3. image build for this host's architecture, labelled like CI builds
#   4. image checks (yt-dlp pin, PO token plugin, deployment bundle)
#   5. PO token provider smoke test with the production hardening
#   6. push to ghcr.io/haxurus/muse (:main and :sha-<commit>), print the digest
#
# Usage: sudo ./ops/manual-release.sh            (full run, pushes)
#        sudo ./ops/manual-release.sh --no-push  (everything except the push)
# It never deploys: run muse-deploy with the printed digest afterwards.
set -euo pipefail
umask 077

IMAGE_REPO=ghcr.io/haxurus/muse
PUSH=1
WORK=""
BUILDER_TAG=""
SMOKE_CID=""

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

cleanup() {
  [[ -n "$SMOKE_CID" ]] && docker rm -f "$SMOKE_CID" >/dev/null 2>&1
  [[ -n "$BUILDER_TAG" ]] && docker image rm "$BUILDER_TAG" >/dev/null 2>&1
  [[ -n "$WORK" ]] && rm -rf -- "$WORK"
  return 0
}
trap cleanup EXIT

case "${1:-}" in
  "") ;;
  --no-push) PUSH=0 ;;
  *) die "Usage: $0 [--no-push]" ;;
esac

[[ "$(id -u)" -eq 0 ]] || die "Run as root (Docker access)."
cd "$(dirname "$0")/.."
[[ -f Dockerfile && -f deploy/docker-compose.prod.yml ]] || die "Run from a Muse checkout."

# --- Source: exactly origin/main, no local changes --------------------------
git fetch --quiet origin main
[[ -z "$(git status --porcelain)" ]] || die "The checkout has local changes; use a fresh clone."
commit="$(git rev-parse HEAD)"
[[ "$commit" == "$(git rev-parse origin/main)" ]] \
  || die "HEAD ($commit) is not origin/main; run: git checkout main && git pull --ff-only"
build_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Releasing $commit"

WORK="$(mktemp -d /tmp/muse-release.XXXXXX)"
BUILDER_TAG="muse-release-builder:$commit"

# --- 1. Validation in the builder stage --------------------------------------
docker build --quiet --target builder -t "$BUILDER_TAG" . >/dev/null
# Tests read files outside the image build context (.github, Dockerfile), so
# they run on a copy of the full checkout with the builder's node_modules.
docker run --rm --network none -v "$PWD:/src:ro" -w /work "$BUILDER_TAG" sh -ec '
  cp -a /src/. /work/
  rm -rf /work/node_modules /work/.git
  cp -a /usr/app/node_modules /work/node_modules
  yarn --silent lint
  yarn --silent typecheck
  node --check dashboard/dashboard.js
  node --check dashboard/home.js
  yarn --silent test
  yarn --silent build
'
echo "Lint, typecheck, tests and build passed."

# --- 2. Compose validation (same placeholders as CI) -------------------------
compose_dir="$WORK/compose"
install -d "$compose_dir/secrets" "$compose_dir/config"
cp deploy/*.yml "$compose_dir/"
cp deploy/.env.production.example "$compose_dir/.env"
cp deploy/workers.json "$compose_dir/config/workers.json"
for secret in \
  orchestrator_api_token dashboard_discord_client_secret \
  discord_token_01 discord_token_02 discord_token_03 discord_token_04 discord_token_05 \
  control_token_01 control_token_02 control_token_03 control_token_04 control_token_05 \
  youtube_api_key spotify_client_id spotify_client_secret youtube_cookies; do
  printf 'ci-placeholder\n' > "$compose_dir/secrets/$secret"
done
MUSE_IMAGE="$IMAGE_REPO@sha256:$(printf 'a%.0s' {1..64})" \
  docker compose --project-name muse-release-check --project-directory "$compose_dir" \
  --env-file "$compose_dir/.env" -f "$compose_dir/docker-compose.prod.yml" config -q
echo "Compose configuration is valid."

# --- 3. Image build -----------------------------------------------------------
docker build \
  --build-arg "COMMIT_HASH=$commit" \
  --build-arg "BUILD_DATE=$build_date" \
  --label "org.opencontainers.image.source=https://github.com/haxurus/muse" \
  --label "org.opencontainers.image.revision=$commit" \
  --label "org.opencontainers.image.created=$build_date" \
  -t "$IMAGE_REPO:main" -t "$IMAGE_REPO:sha-$commit" .

# --- 4. Image checks ------------------------------------------------------------
image="$IMAGE_REPO:sha-$commit"
version="$(sed -n 's/^ARG YT_DLP_VERSION=//p' Dockerfile)"
[[ "$(docker run --rm --network none --entrypoint yt-dlp "$image" --version)" == "$version" ]] \
  || die "The image does not contain yt-dlp $version."
docker run --rm --network none --entrypoint /opt/yt-dlp/bin/python "$image" \
  -c "import yt_dlp_plugins.extractor.getpot_bgutil_http" \
  || die "The image does not contain the PO token plugin."
bundle="$WORK/bundle"
install -d "$bundle"
cid="$(docker create "$image")"
docker cp "$cid:/opt/muse-deploy/." "$bundle/"
docker rm -f "$cid" >/dev/null
for file in "$bundle"/*; do
  cmp "$file" "deploy/$(basename "$file")"
done
echo "Image checks passed."

# --- 5. PO token provider smoke test -------------------------------------------
provider="$(sed -n 's/^    image: \(brainicism\/bgutil-ytdlp-pot-provider:.*@sha256:[a-f0-9]*\)$/\1/p' deploy/docker-compose.prod.yml)"
[[ -n "$provider" ]] || die "No digest-pinned pot-provider image in the Compose file."
SMOKE_CID="$(docker run -d --init --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --cap-drop ALL --security-opt no-new-privileges:true "$provider")"
ready=0
for _ in $(seq 1 30); do
  if docker exec "$SMOKE_CID" node -e "fetch('http://127.0.0.1:4416/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" -ne 1 ]]; then
  docker logs "$SMOKE_CID" >&2 || true
  die "The PO token provider did not answer /ping."
fi
docker rm -f "$SMOKE_CID" >/dev/null
SMOKE_CID=""
echo "PO token provider starts with the production hardening."

# --- 6. Push --------------------------------------------------------------------
if [[ "$PUSH" -eq 0 ]]; then
  echo "Skipping the push (--no-push). Nothing was published."
  exit 0
fi

docker push --quiet "$IMAGE_REPO:sha-$commit" >/dev/null
docker push --quiet "$IMAGE_REPO:main" >/dev/null
digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" \
  | grep -m1 "^$IMAGE_REPO@sha256:" || true)"
[[ "$digest" =~ ^ghcr\.io/haxurus/muse@sha256:[a-f0-9]{64}$ ]] || die "Could not read the pushed digest."

cat <<EOF

Published $commit ($(uname -m) only).
Deploy it with:

  sudo /usr/local/sbin/muse-deploy deploy $digest

Then remove the registry credentials: sudo docker logout ghcr.io
EOF
