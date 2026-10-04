#!/bin/bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE=/srv/docker/muse
DEPLOY_USER=muse-deploy
PUBLIC_KEY_PATH="${1:-}"

for cmd in docker install sshd systemctl iptables; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required." >&2
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
install -d -m 700 -o 1000 -g 1000 "$BASE/data"

install -m 600 -o root -g root "$REPO_ROOT/deploy/docker-compose.prod.yml" "$BASE/docker-compose.yml"

if [[ ! -f "$BASE/.env" ]]; then
  install -m 600 -o root -g root "$REPO_ROOT/deploy/.env.production.example" "$BASE/.env"
fi

for secret in discord_token youtube_api_key spotify_client_id spotify_client_secret; do
  if [[ ! -e "$BASE/secrets/$secret" ]]; then
    install -m 600 -o root -g root /dev/null "$BASE/secrets/$secret"
  else
    chmod 600 "$BASE/secrets/$secret"
    chown root:root "$BASE/secrets/$secret"
  fi
done

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
echo "Muse production infrastructure installed in $BASE."
echo "Next:"
echo "  1. Fill $BASE/secrets/discord_token"
echo "  2. Fill $BASE/secrets/youtube_api_key"
echo "  3. Optionally fill both Spotify secret files"
echo "  4. Review $BASE/.env"
echo "  5. Configure GitHub production environment and ENABLE_VPS_DEPLOY=true"
