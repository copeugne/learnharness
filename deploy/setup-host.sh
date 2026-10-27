#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root on oci-main.' >&2; exit 1; }
release=${1:?Pass the reviewed absolute release directory}
[[ "$release" == /opt/learnharness/releases/* && -f "$release/deploy/gateway.mjs" ]] || { echo 'Unexpected release directory.' >&2; exit 1; }
chown -R root:root "$release"
printf '[host] 0%% (0/5) Installing quota tools\n'
dnf install -y quota
id learn-gateway >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin learn-gateway
usermod -aG docker learn-gateway
install -d -m 0700 /srv/learnharness
install -d -m 0700 /srv/learnharness/tenants
install -d -m 0700 -o learn-gateway -g learn-gateway /var/lib/learnharness-gateway
install -d -m 0750 /etc/learnharness
printf '[host] 20%% (1/5) Reserving dedicated tenant storage\n'
image=/srv/learnharness/tenants.ext4
if [[ ! -f "$image" ]]; then
    available=$(df --output=avail -B1 /srv/learnharness | tail -n 1 | tr -d ' ')
    (( available > 3758096384 )) || { echo 'Need over 3.5 GiB free before reserving tenant storage.' >&2; exit 1; }
    fallocate -l 1536M "$image"
    chmod 0600 "$image"
    mkfs.ext4 -q -O quota -E nodiscard,quotatype=usrquota -L learn-tenants "$image"
fi
[[ $(blkid -s LABEL -o value "$image") == learn-tenants ]] || { echo 'Unexpected tenant filesystem label.' >&2; exit 1; }
# Preserve the host reservation even when resuming a filesystem created by
# an earlier tool invocation that discarded unused image extents.
fallocate -l 1536M "$image"
entry='/srv/learnharness/tenants.ext4 /srv/learnharness/tenants ext4 loop,nodev,nosuid,usrquota 0 0'
if ! grep -q '^/srv/learnharness/tenants\.ext4 ' /etc/fstab; then
    printf '%s\n' "$entry" >> /etc/fstab
fi
mountpoint -q /srv/learnharness/tenants || mount /srv/learnharness/tenants
if quota_status=$(quotaon -p -u /srv/learnharness/tenants); then
    printf '%s\n' "$quota_status"
else
    # quotaon -p returns the number of filesystems whose quotas are on.
    [[ "$quota_status" == "user quota on /srv/learnharness/tenants ("*") is on" ]] || { printf '%s\n' "$quota_status" >&2; exit 1; }
    printf '%s\n' "$quota_status"
fi
printf '[host] 40%% (2/5) Installing private volume provisioner\n'
install -D -m 0755 "$release/deploy/provision.mjs" /usr/local/libexec/learn-provision
printf 'learn-gateway ALL=(root) NOPASSWD: /usr/local/libexec/learn-provision *\n' > /etc/sudoers.d/learn-gateway.tmp
chmod 0440 /etc/sudoers.d/learn-gateway.tmp
visudo -cf /etc/sudoers.d/learn-gateway.tmp
mv /etc/sudoers.d/learn-gateway.tmp /etc/sudoers.d/learn-gateway
printf '[host] 60%% (3/5) Installing tenant network and gateway service definitions\n'
ln -sfn "$release" /opt/learnharness/current
chmod 0755 "$release/deploy/tenant-network.sh"
install -m 0644 "$release/deploy/learn-network.service" /etc/systemd/system/learn-network.service
install -m 0644 "$release/deploy/learn-gateway.service" /etc/systemd/system/learn-gateway.service
restorecon -RF /opt/learnharness /usr/local/libexec/learn-provision /etc/systemd/system/learn-network.service /etc/systemd/system/learn-gateway.service /etc/sudoers.d/learn-gateway
systemctl daemon-reload
systemctl enable --now learn-network.service
printf '[host] 80%% (4/5) Verifying quota mount and storage headroom\n'
findmnt /srv/learnharness/tenants
repquota -u /srv/learnharness/tenants
df -h / /srv/learnharness/tenants
printf '[host] 100%% (5/5) Private tenant host prepared. Gateway and public ingress are not started by this script.\n'
