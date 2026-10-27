#!/usr/bin/env bash
set -euo pipefail
# Install as a root-owned oneshot before the gateway. Applies only to this
# dedicated Docker network; existing Docker networks and services stay intact.
subnet=172.30.88.0/24
bridge=br-learn
if ! docker network inspect learn-tenants >/dev/null 2>&1; then
    docker network create --driver bridge --subnet "$subnet" \
        --opt com.docker.network.bridge.name="$bridge" \
        --opt com.docker.network.bridge.enable_icc=false learn-tenants
fi
actual=$(docker network inspect learn-tenants --format '{{(index .IPAM.Config 0).Subnet}}')
[[ "$actual" == "$subnet" ]] || { echo 'Unexpected learn-tenants subnet' >&2; exit 1; }
# Block access to the host, other private networks, link-local cloud metadata,
# multicast and reserved destinations. DNS uses Docker's embedded resolver.
for destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
    iptables -C DOCKER-USER -s "$subnet" -d "$destination" -j REJECT 2>/dev/null || \
        iptables -I DOCKER-USER 1 -s "$subnet" -d "$destination" -j REJECT
done
iptables -C INPUT -i "$bridge" -j REJECT 2>/dev/null || iptables -I INPUT 1 -i "$bridge" -j REJECT
iptables -C DOCKER-USER -s "$subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN 2>/dev/null || \
    iptables -I DOCKER-USER 1 -s "$subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -C INPUT -i "$bridge" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
    iptables -I INPUT 1 -i "$bridge" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
printf '[network] 100%% (1/1) Tenant host/private-network restrictions installed\n'
