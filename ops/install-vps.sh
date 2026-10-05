#!/bin/bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE=/srv/docker/muse
DEPLOY_USER=muse-deploy
RUNTIME_UID=10001
RUNTIME_GID=10001
PUBLIC_KEY_PATH="${1:-}"
# Optional: name of the Nginx Proxy Manager container to attach to muse-edge.
NPM_CONTAINER="${MUSE_NPM_CONTAINER:-}"
EDGE_NETWORK=muse-edge
EDGE_BRIDGE=muse-ed
ENTRYPOINT=/usr/local/libexec/muse-deploy-entrypoint
KEYS_DIR=/etc/ssh/authorized_keys
KEY_FILE="$KEYS_DIR/$DEPLOY_USER"
SSHD_DROPIN=/etc/ssh/sshd_config.d/60-muse-deploy.conf
OVERLAYS=(bot-one-playback bot-two-playback bot-three-playback bot-four-playback bot-five-playback)

for cmd in docker install sshd systemctl iptables openssl visudo flock tar awk; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required." >&2
  exit 1
fi

allow_users="$(sshd -T 2>/dev/null | awk '$1=="allowusers"{for(i=2;i<=NF;i++) print $i}')"
if [[ -n "$allow_users" ]] && ! grep -qx "$DEPLOY_USER" <<<"$allow_users"; then
  echo "sshd AllowUsers is enabled but does not include $DEPLOY_USER." >&2
  echo "Add it to the existing AllowUsers line yourself, validate with 'sshd -t'," >&2
  echo "reload SSH, then rerun this installer. The installer never edits AllowUsers." >&2
  exit 1
fi

if ! grep -Eqs '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
  echo "/etc/ssh/sshd_config does not include /etc/ssh/sshd_config.d/*.conf." >&2
  echo "Add 'Include /etc/ssh/sshd_config.d/*.conf' near the top, validate with 'sshd -t', then rerun." >&2
  exit 1
fi

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi

# --- Directory layout ------------------------------------------------------

install -d -m 700 -o root -g root "$BASE"
install -d -m 700 -o root -g root "$BASE/secrets" "$BASE/backups" "$BASE/.deploy-state" "$BASE/overlays"
install -d -m 755 -o root -g root "$BASE/config" "$BASE/data"
install -d -m 700 -o "$RUNTIME_UID" -g "$RUNTIME_GID" "$BASE/data/orchestrator"

for worker in 01 02 03 04 05; do
  install -d -m 700 -o "$RUNTIME_UID" -g "$RUNTIME_GID" "$BASE/data/bot-$worker"
done

# Compose files are seeded only on the first installation. Afterwards every
# `muse-deploy deploy` installs the copies shipped inside the deployed image,
# so rerunning an older checkout of this installer never downgrades them.
install_if_missing() {
  local src="$1" dst="$2" mode="$3"
  if [[ ! -f "$dst" ]]; then
    install -m "$mode" -o root -g root "$src" "$dst"
  fi
}

install_if_missing "$REPO_ROOT/deploy/docker-compose.prod.yml" "$BASE/docker-compose.yml" 600
install_if_missing "$REPO_ROOT/deploy/workers.json" "$BASE/config/workers.json" 644
for overlay in "${OVERLAYS[@]}"; do
  install_if_missing "$REPO_ROOT/deploy/docker-compose.$overlay.yml" "$BASE/overlays/docker-compose.$overlay.yml" 600
done

if [[ ! -f "$BASE/.env" ]]; then
  install -m 600 -o root -g root "$REPO_ROOT/deploy/.env.production.example" "$BASE/.env"
elif ! grep -q '^MUSE_COMPOSE_OVERLAYS=' "$BASE/.env"; then
  printf '\n# Optional playback pilot overlays, e.g. bot-one-playback,bot-two-playback\nMUSE_COMPOSE_OVERLAYS=\n' >> "$BASE/.env"
fi

# --- Runtime secrets -------------------------------------------------------

ensure_runtime_secret() {
  local secret="$1"
  if [[ ! -e "$BASE/secrets/$secret" ]]; then
    install -m 640 -o root -g "$RUNTIME_GID" /dev/null "$BASE/secrets/$secret"
  else
    chown root:"$RUNTIME_GID" "$BASE/secrets/$secret"
    chmod 640 "$BASE/secrets/$secret"
  fi
}

ensure_generated_secret() {
  local secret="$1"
  ensure_runtime_secret "$secret"
  if [[ ! -s "$BASE/secrets/$secret" ]]; then
    (umask 027 && openssl rand -hex 32 > "$BASE/secrets/$secret")
    chown root:"$RUNTIME_GID" "$BASE/secrets/$secret"
    chmod 640 "$BASE/secrets/$secret"
  fi
}

for worker in 01 02 03 04 05; do
  ensure_runtime_secret "discord_token_$worker"
  ensure_generated_secret "control_token_$worker"
done

ensure_generated_secret orchestrator_api_token
ensure_runtime_secret dashboard_discord_client_secret
ensure_runtime_secret youtube_api_key
ensure_runtime_secret spotify_client_id
ensure_runtime_secret spotify_client_secret

# --- Dedicated ingress network for the dashboard edge -------------------------

# Internal bridge: Docker gives it no external route, so the edge container can
# talk only to peers on the same bridge (Nginx Proxy Manager). The muse-ed
# bridge is additionally filtered by the host firewall.
if ! docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1; then
  docker network create \
    --driver bridge \
    --internal \
    --opt "com.docker.network.bridge.name=$EDGE_BRIDGE" \
    "$EDGE_NETWORK" >/dev/null
  echo "Created Docker network $EDGE_NETWORK (bridge $EDGE_BRIDGE)."
else
  edge_internal="$(docker network inspect --format '{{.Internal}}' "$EDGE_NETWORK")"
  edge_bridge="$(docker network inspect --format '{{index .Options "com.docker.network.bridge.name"}}' "$EDGE_NETWORK")"
  if [[ "$edge_internal" != "true" || "$edge_bridge" != "$EDGE_BRIDGE" ]]; then
    echo "Existing network $EDGE_NETWORK is not an internal bridge named $EDGE_BRIDGE; fix it manually." >&2
    exit 1
  fi
fi

if [[ -n "$NPM_CONTAINER" ]]; then
  # $k and $v are Go template variables, not shell expansions.
  # shellcheck disable=SC2016
  npm_networks="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}} {{$k}}{{end}}' "$NPM_CONTAINER")"
  if [[ " $npm_networks " == *" $EDGE_NETWORK "* ]]; then
    echo "$NPM_CONTAINER is already attached to $EDGE_NETWORK."
  else
    docker network connect "$EDGE_NETWORK" "$NPM_CONTAINER"
    echo "Attached $NPM_CONTAINER to $EDGE_NETWORK (also declare it in the NPM Compose file to persist)."
  fi
fi

# --- Deploy tooling and firewall -------------------------------------------

install -m 750 -o root -g root "$REPO_ROOT/ops/muse-deploy" /usr/local/sbin/muse-deploy
install -d -m 755 -o root -g root /usr/local/libexec
install -m 755 -o root -g root "$REPO_ROOT/ops/muse-deploy-entrypoint" "$ENTRYPOINT"

install -m 755 -o root -g root "$REPO_ROOT/security/host-firewall.sh" /usr/local/sbin/muse-host-firewall
install -m 644 -o root -g root "$REPO_ROOT/security/muse-firewall.service" /etc/systemd/system/muse-firewall.service

sudoers_tmp="$(mktemp)"
trap 'rm -f -- "$sudoers_tmp"' EXIT
cat >"$sudoers_tmp" <<'EOF'
# Managed by muse ops/install-vps.sh. Only the three forced-command operations.
muse-deploy ALL=(root) NOPASSWD: /usr/local/sbin/muse-deploy status, /usr/local/sbin/muse-deploy rollback, /usr/local/sbin/muse-deploy deploy ghcr.io/haxurus/muse@sha256\:*
EOF
visudo -cf "$sudoers_tmp" >/dev/null
install -m 440 -o root -g root "$sudoers_tmp" /etc/sudoers.d/muse-deploy
visudo -c >/dev/null

# --- SSH: root-owned forced-command key ------------------------------------

# The deploy key lives in a root-owned file outside the deploy user's home, so
# the account cannot add keys or drop the forced command.
install -d -m 755 -o root -g root "$KEYS_DIR"
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
LEGACY_KEYS="$DEPLOY_HOME/.ssh/authorized_keys"
KEY_PREFIX="restrict,command=\"$ENTRYPOINT\" "

rm -f -- "$KEY_FILE.new"
if [[ -n "$PUBLIC_KEY_PATH" ]]; then
  [[ -f "$PUBLIC_KEY_PATH" ]] || { echo "Public key not found: $PUBLIC_KEY_PATH" >&2; exit 1; }
  public_key="$(tr -d '\r\n' < "$PUBLIC_KEY_PATH")"
  [[ "$public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [^[:cntrl:]]*)?$ ]] \
    || { echo "Only a single ssh-ed25519 deploy key is accepted." >&2; exit 1; }
  printf '%s%s\n' "$KEY_PREFIX" "$public_key" > "$KEY_FILE.new"
elif [[ ! -s "$KEY_FILE" && -s "$LEGACY_KEYS" ]]; then
  # Migrate a key installed by an older installer version, if it is well formed.
  if grep -qv "^restrict,command=\"$ENTRYPOINT\" ssh-ed25519 " "$LEGACY_KEYS"; then
    echo "$LEGACY_KEYS contains unexpected entries; rerun with the deploy public key path." >&2
    exit 1
  fi
  cp -- "$LEGACY_KEYS" "$KEY_FILE.new"
elif [[ ! -s "$KEY_FILE" ]]; then
  echo "A deploy public key is required on the first installation." >&2
  exit 1
fi

if [[ -f "$KEY_FILE.new" ]]; then
  chown root:root "$KEY_FILE.new"
  chmod 644 "$KEY_FILE.new"
  mv -f -- "$KEY_FILE.new" "$KEY_FILE"
fi

sshd_backup=""
if [[ -f "$SSHD_DROPIN" ]]; then
  sshd_backup="$(mktemp)"
  cp -p -- "$SSHD_DROPIN" "$sshd_backup"
fi

cat >"$SSHD_DROPIN" <<EOF
# Managed by muse ops/install-vps.sh.
Match User $DEPLOY_USER
    AuthorizedKeysFile $KEYS_DIR/%u
    AuthenticationMethods publickey
    PasswordAuthentication no
    PermitTTY no
    AllowAgentForwarding no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
Match all
EOF
chmod 644 "$SSHD_DROPIN"

if ! sshd -t; then
  echo "sshd rejected $SSHD_DROPIN; restoring the previous state." >&2
  if [[ -n "$sshd_backup" ]]; then
    mv -f -- "$sshd_backup" "$SSHD_DROPIN"
  else
    rm -f -- "$SSHD_DROPIN"
  fi
  exit 1
fi
[[ -z "$sshd_backup" ]] || rm -f -- "$sshd_backup"

effective="$(sshd -T -C "user=$DEPLOY_USER,host=localhost,addr=127.0.0.1")"
effective_keys="$(awk '$1=="authorizedkeysfile"{print $2}' <<<"$effective")"
effective_password="$(awk '$1=="passwordauthentication"{print $2}' <<<"$effective")"
if [[ "$effective_keys" != "$KEYS_DIR/%u" || "$effective_password" != "no" ]]; then
  echo "sshd does not apply $SSHD_DROPIN to $DEPLOY_USER (authorizedkeysfile=$effective_keys, passwordauthentication=$effective_password)." >&2
  echo "An earlier Match block or AuthorizedKeysFile setting probably wins; fix sshd_config manually." >&2
  exit 1
fi

systemctl reload ssh 2>/dev/null || systemctl reload sshd
rm -f -- "$LEGACY_KEYS"

# --- Firewall --------------------------------------------------------------

systemctl daemon-reload
systemctl enable muse-firewall.service >/dev/null
/usr/local/sbin/muse-host-firewall

echo
echo "Muse dashboard + orchestrator + five-worker infrastructure installed in $BASE."
echo "Next:"
echo "  1. Fill discord_token_01 through discord_token_05"
echo "  2. Fill youtube_api_key"
echo "  3. Fill dashboard_discord_client_secret"
echo "  4. Set MUSE_DASHBOARD_PUBLIC_URL and MUSE_DASHBOARD_DISCORD_CLIENT_ID in $BASE/.env"
echo "  5. Register <public-url>/auth/discord/callback in the Discord OAuth application"
echo "  6. Optionally fill both Spotify secret files"
if [[ -z "$NPM_CONTAINER" ]]; then
  echo "  7. Attach Nginx Proxy Manager to $EDGE_NETWORK: docker network connect $EDGE_NETWORK <npm-container>"
  echo "     and declare $EDGE_NETWORK as an external network in the NPM Compose file"
else
  echo "  7. Declare $EDGE_NETWORK as an external network in the NPM Compose file"
fi
echo "  8. Configure NPM to proxy the dashboard hostname to muse-dashboard:8080"
echo "  9. Run the first deploy manually (docs/DEPLOYMENT.md) before enabling ENABLE_VPS_DEPLOY"
