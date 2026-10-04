#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

command -v iptables >/dev/null 2>&1 || { echo "iptables is required" >&2; exit 1; }

iface="muse-eg"

iptables -C INPUT -i "$iface" -j DROP 2>/dev/null || iptables -I INPUT 1 -i "$iface" -j DROP

for cidr in \
  10.0.0.0/8 \
  100.64.0.0/10 \
  127.0.0.0/8 \
  169.254.0.0/16 \
  172.16.0.0/12 \
  192.168.0.0/16 \
  224.0.0.0/4 \
  240.0.0.0/4; do
  iptables -C DOCKER-USER -i "$iface" -d "$cidr" -j REJECT 2>/dev/null \
    || iptables -I DOCKER-USER 1 -i "$iface" -d "$cidr" -j REJECT
done

echo "Muse egress isolation rules installed."
