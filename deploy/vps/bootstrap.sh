#!/bin/bash
# cubr production host bootstrap: Debian 13 (trixie) on a small VM, run once as root (safe to re-run).
#   - 2 GB swap file: the stack uses ~0.8-1.2 GB of an e2-small's 2 GB, swap absorbs spikes
#   - Docker Engine + compose plugin from Docker's own apt repository
#   - Docker log rotation (json-file, 3 x 10 MB per container) so logs can't fill the disk
#   - automatic security updates (unattended-upgrades)
#   - lets the deploy user run docker without sudo
# Usage (from a laptop, through IAP):
#   gcloud compute ssh cubr-1 --tunnel-through-iap --command 'sudo bash -s -- "$USER"' < deploy/vps/bootstrap.sh
set -euo pipefail
DEPLOY_USER="${1:-${SUDO_USER:-}}"
export DEBIAN_FRONTEND=noninteractive

# --- swap
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/90-cubr.conf
sysctl -q --load /etc/sysctl.d/90-cubr.conf

# --- base packages
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg unattended-upgrades >/dev/null

# --- Docker Engine (https://docs.docker.com/engine/install/debian/)
install -m 0755 -d /etc/apt/keyrings
if [ ! -s /etc/apt/keyrings/docker.asc ]; then
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null

# --- Docker log rotation (applies to containers created after this)
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
systemctl enable docker >/dev/null 2>&1
systemctl restart docker

# --- automatic security updates (Debian's default unattended-upgrades origins = security)
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT

# --- deploy user may run docker
if [ -n "$DEPLOY_USER" ] && id "$DEPLOY_USER" >/dev/null 2>&1; then
  usermod -aG docker "$DEPLOY_USER"
fi

echo "bootstrap done: $(docker --version | cut -d, -f1), $(docker compose version --short) compose, swap $(swapon --show=SIZE --noheadings | head -1)"
