#!/bin/sh
# Muse host firewall: isolates the Muse Docker bridges from the host, from
# private networks and (for the dashboard edge) from everything but NPM.
#
#   muse-host-firewall           install/refresh the rules (idempotent)
#   muse-host-firewall --remove  delete every rule and chain this script owns
#
# Rules live in dedicated chains (MUSE-FORWARD, MUSE-INPUT) that are flushed and
# rebuilt on every run, so ordering is deterministic and reruns never duplicate.
# MUSE-FORWARD is jumped to from DOCKER-USER, which Docker preserves across
# restarts; the chain is created here when the unit runs before docker.service.
set -eu

FWD_CHAIN=MUSE-FORWARD
IN_CHAIN=MUSE-INPUT
EGRESS_IFACES="muse-eg muse-deg"
INTERNAL_IFACES="muse-dw muse-dc muse-c01 muse-c02 muse-c03 muse-c04 muse-c05 muse-p01 muse-p02 muse-p03 muse-p04 muse-p05"
EDGE_IFACE=muse-ed
EDGE_PORT=8080
ALL_IFACES="$EGRESS_IFACES $INTERNAL_IFACES $EDGE_IFACE"
BLOCKED_CIDRS="10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

command -v iptables >/dev/null 2>&1 || { echo "iptables is required" >&2; exit 1; }

HAVE_IP6=0
if command -v ip6tables >/dev/null 2>&1 && ip6tables -w -n -L FORWARD >/dev/null 2>&1; then
  HAVE_IP6=1
fi

ensure_chain() {
  "$1" -w -n -L "$2" >/dev/null 2>&1 || "$1" -w -N "$2"
}

ensure_jump() {
  "$1" -w -C "$2" -j "$3" 2>/dev/null || "$1" -w -I "$2" 1 -j "$3"
}

# delete_rule <iptables|ip6tables> <chain> <rule...>: removes every copy.
delete_rule() {
  cmd="$1"
  chain="$2"
  shift 2
  while "$cmd" -w -C "$chain" "$@" 2>/dev/null; do
    "$cmd" -w -D "$chain" "$@"
  done
}

drop_chain() {
  if "$1" -w -n -L "$2" >/dev/null 2>&1; then
    "$1" -w -F "$2"
    "$1" -w -X "$2"
  fi
}

# Rules inserted directly into INPUT/DOCKER-USER by earlier versions.
remove_legacy_rules() {
  for iface in $ALL_IFACES; do
    delete_rule iptables INPUT -i "$iface" -j DROP
  done
  if iptables -w -n -L DOCKER-USER >/dev/null 2>&1; then
    for cidr in $BLOCKED_CIDRS; do
      for iface in $EGRESS_IFACES; do
        delete_rule iptables DOCKER-USER -i "$iface" -d "$cidr" -j REJECT
      done
    done
  fi
}

# IPv4 resolvers that Docker's embedded DNS forwards to from the container
# network namespace. Loopback resolvers are skipped: Docker reaches those from
# the host namespace, so they never cross the Muse bridges.
dns_resolvers() {
  {
    for file in /run/systemd/resolve/resolv.conf /etc/resolv.conf; do
      if [ -r "$file" ]; then
        awk '$1 == "nameserver" {print $2}' "$file"
      fi
    done
    if command -v resolvectl >/dev/null 2>&1; then
      resolvectl dns 2>/dev/null | tr '[:blank:]' '\n' || true
    fi
  } | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' | grep -v '^127\.' | sort -u
}

apply_ipv4() {
  ensure_chain iptables DOCKER-USER
  ensure_chain iptables "$FWD_CHAIN"
  ensure_chain iptables "$IN_CHAIN"
  iptables -w -F "$FWD_CHAIN"
  iptables -w -F "$IN_CHAIN"

  iptables -w -A "$FWD_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

  # DNS to the host's upstream resolvers stays allowed even when they sit in a
  # blocked private range (common for cloud VPC resolvers).
  resolvers="$(dns_resolvers)"
  for dns in $resolvers; do
    for iface in $EGRESS_IFACES; do
      iptables -w -A "$FWD_CHAIN" -i "$iface" -d "$dns" -p udp --dport 53 -j RETURN
      iptables -w -A "$FWD_CHAIN" -i "$iface" -d "$dns" -p tcp --dport 53 -j RETURN
    done
  done

  # Egress bridges: Internet only, no private/link-local/multicast destinations.
  for cidr in $BLOCKED_CIDRS; do
    for iface in $EGRESS_IFACES; do
      iptables -w -A "$FWD_CHAIN" -i "$iface" -d "$cidr" -j REJECT
    done
  done

  # Edge bridge: only new TCP connections to the edge port from a peer on the
  # same bridge (Nginx Proxy Manager). The edge itself can initiate nothing.
  iptables -w -A "$FWD_CHAIN" -i "$EDGE_IFACE" -o "$EDGE_IFACE" -p tcp --dport "$EDGE_PORT" \
    -m conntrack --ctstate NEW -j RETURN
  iptables -w -A "$FWD_CHAIN" -i "$EDGE_IFACE" -j REJECT
  iptables -w -A "$FWD_CHAIN" -o "$EDGE_IFACE" -j REJECT

  ensure_jump iptables DOCKER-USER "$FWD_CHAIN"

  # No Muse bridge may open connections to services on the host itself.
  iptables -w -A "$IN_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for iface in $ALL_IFACES; do
    iptables -w -A "$IN_CHAIN" -i "$iface" -j DROP
  done
  ensure_jump iptables INPUT "$IN_CHAIN"

  if [ -n "$resolvers" ]; then
    echo "DNS allowed from Muse egress bridges to: $(printf '%s' "$resolvers" | tr '\n' ' ')"
  else
    echo "No non-loopback IPv4 resolvers detected; no DNS exceptions added."
  fi
}

# Muse networks are IPv4-only (enable_ipv6: false). Reject any IPv6 that still
# reaches the bridges, as defence in depth. Best effort when ip6tables exists.
apply_ipv6() {
  ensure_chain ip6tables DOCKER-USER
  ensure_chain ip6tables "$FWD_CHAIN"
  ensure_chain ip6tables "$IN_CHAIN"
  ip6tables -w -F "$FWD_CHAIN"
  ip6tables -w -F "$IN_CHAIN"
  for iface in $ALL_IFACES; do
    ip6tables -w -A "$FWD_CHAIN" -i "$iface" -j REJECT
    ip6tables -w -A "$FWD_CHAIN" -o "$iface" -j REJECT
    ip6tables -w -A "$IN_CHAIN" -i "$iface" -j DROP
  done
  ensure_jump ip6tables DOCKER-USER "$FWD_CHAIN"
  ensure_jump ip6tables FORWARD "$FWD_CHAIN"
  ensure_jump ip6tables INPUT "$IN_CHAIN"
}

remove_ipv4() {
  if iptables -w -n -L DOCKER-USER >/dev/null 2>&1; then
    delete_rule iptables DOCKER-USER -j "$FWD_CHAIN"
  fi
  delete_rule iptables INPUT -j "$IN_CHAIN"
  drop_chain iptables "$FWD_CHAIN"
  drop_chain iptables "$IN_CHAIN"
}

remove_ipv6() {
  if ip6tables -w -n -L DOCKER-USER >/dev/null 2>&1; then
    delete_rule ip6tables DOCKER-USER -j "$FWD_CHAIN"
  fi
  delete_rule ip6tables FORWARD -j "$FWD_CHAIN"
  delete_rule ip6tables INPUT -j "$IN_CHAIN"
  drop_chain ip6tables "$FWD_CHAIN"
  drop_chain ip6tables "$IN_CHAIN"
}

warn_environment() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet docker 2>/dev/null; then
    if ! iptables -w -C FORWARD -j DOCKER-USER 2>/dev/null; then
      echo "WARNING: FORWARD has no jump to DOCKER-USER. Docker may use the nftables firewall backend; these rules would not apply." >&2
    fi
  fi
  if [ "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null || echo 0)" != "1" ]; then
    echo "WARNING: net.bridge.bridge-nf-call-iptables is not 1; traffic between peers on muse-ed is not filtered (muse-edge stays an internal network)." >&2
  fi
}

case "${1:-}" in
  "")
    remove_legacy_rules
    apply_ipv4
    if [ "$HAVE_IP6" -eq 1 ]; then
      apply_ipv6
    else
      echo "ip6tables unavailable; IPv6 defence-in-depth rules skipped."
    fi
    warn_environment
    echo "Muse worker, control-plane and edge isolation rules installed."
    ;;
  --remove)
    remove_legacy_rules
    remove_ipv4
    if [ "$HAVE_IP6" -eq 1 ]; then
      remove_ipv6
    fi
    echo "Muse isolation rules removed."
    ;;
  *)
    echo "Usage: $0 [--remove]" >&2
    exit 64
    ;;
esac
