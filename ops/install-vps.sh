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

for cmd in docker install sshd systemctl iptables openssl visudo; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required." >&2
  exit 1
fi

if ! docker network inspect proxy_net >/dev/null 2>&1; then
  echo "Required external Docker network proxy_net does not exist." >&2
  exit 1
fi

allow_users="$(sshd -T 2>/dev/null | awk '$1=="allowusers"{for(i=2;i<=NF;i++) print $i}')"
if [[ -n "$allow_users" ]] && ! grep -qx "$DEPLOY_USER" <<<"$allow_users"; then
  echo "sshd AllowUsers is enabled but does not include $DEPLOY_USER." >&2
  echo "Add it, validate with 'sshd -t', reload SSH, then rerun this installer." >&2
  exit 1
fi

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi

install -d -m 700 -o root -g root "$BASE"
install -d -m 700 -o root -g root "$BASE/secrets" "$BASE/backups" "$BASE/.deploy-state"
install -d -m 755 -o root -g root "$BASE/config" "$BASE/data"
install -d -m 700 -o "$RUNTIME_UID" -g "$RUNTIME_GID" "$BASE/data/orchestrator"

for worker in 01 02 03 04 05; do
  install -d -m 700 -o "$RUNTIME_UID" -g "$RUNTIME_GID" "$BASE/data/bot-$worker"
done

install -m 600 -o root -g root "$REPO_ROOT/deploy/docker-compose.prod.yml" "$BASE/docker-compose.yml"
install -m 644 -o root -g root "$REPO_ROOT/deploy/workers.json" "$BASE/config/workers.json"

if [[ ! -f "$BASE/.env" ]]; then
  install -m 600 -o root -g root "$REPO_ROOT/deploy/.env.production.example" "$BASE/.env"
fi

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
    umask 027
    openssl rand -hex 32 > "$BASE/secrets/$secret"
    chown root:"$RUNTIME_GID" "$BASE/secrets/$secret"
    chmod 640 "$BASE/secrets/$secret"
  fi
}

for worker in 01 02 03 04 05; do
  ensure_runtime_secret "discord_token_$worker"
  ensure_generated_secret "control_token_$worker"
done

ensure_generated_secret orchestrator_api_token
ensure_generated_secret orchestrator_controller_token
ensure_runtime_secret dashboard_discord_client_secret
ensure_runtime_secret youtube_api_key
ensure_runtime_secret spotify_client_id
ensure_runtime_secret spotify_client_secret

install -m 750 -o root -g root "$REPO_ROOT/ops/muse-deploy" /usr/local/sbin/muse-deploy
install -d -m 755 -o root -g root /usr/local/libexec
install -m 755 -o root -g root "$REPO_ROOT/ops/muse-deploy-entrypoint" /usr/local/libexec/muse-deploy-entrypoint

install -m 755 -o root -g root "$REPO_ROOT/security/host-firewall.sh" /usr/local/sbin/muse-host-firewall
install -m 644 -o root -g root "$REPO_ROOT/security/muse-firewall.service" /etc/systemd/system/muse-firewall.service

cat >/etc/sudoers.d/muse-deploy <<'EOF'
muse-deploy ALL=(root) NOPASSWD: /usr/local/sbin/muse-deploy *
EOF
chmod 440 /etc/sudoers.d/muse-deploy
visudo -cf /etc/sudoers.d/muse-deploy >/dev/null

DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"

if [[ -n "$PUBLIC_KEY_PATH" ]]; then
  [[ -f "$PUBLIC_KEY_PATH" ]] || { echo "Public key not found: $PUBLIC_KEY_PATH" >&2; exit 1; }
  public_key="$(tr -d '\r\n' < "$PUBLIC_KEY_PATH")"
  [[ "$public_key" == ssh-ed25519 * ]] || { echo "Only an ssh-ed25519 deploy key is accepted." >&2; exit 1; }

  printf 'restrict,command="/usr/local/libexec/muse-deploy-entrypoint" %s\n' "$public_key"     > "$DEPLOY_HOME/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh/authorized_keys"
  chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys"
elif [[ ! -s "$DEPLOY_HOME/.ssh/authorized_keys" ]]; then
  echo "A deploy public key is required on the first installation." >&2
  exit 1
fi

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
echo "  7. Configure NPM to proxy the dashboard hostname to muse-dashboard:8080"
echo "  8. Do not enable automatic production deploy until validation is complete"
