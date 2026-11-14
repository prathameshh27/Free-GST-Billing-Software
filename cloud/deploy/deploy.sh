#!/usr/bin/env bash
# Deploys the GST Portal to the server. Run from the repo root (Git Bash on
# Windows is fine):   bash cloud/deploy/deploy.sh
#
# Builds the frontend here (the 1 GB server is too small for vite build),
# copies the app over SSH, installs production dependencies there, swaps the
# new version in and restarts the service. The previous version is kept in
# /opt/gst-portal.prev for a quick rollback:
#   sudo systemctl stop gst-portal && sudo rm -rf /opt/gst-portal && sudo mv /opt/gst-portal.prev /opt/gst-portal && sudo systemctl start gst-portal
set -euo pipefail

HOST="${GSP_DEPLOY_HOST:-ubuntu@130.210.127.108}"
KEY="${GSP_DEPLOY_KEY:-$HOME/.ssh/oci_free_vm}"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new"

cd "$(dirname "$0")/../.."
echo "== build"
npm run build:cloud >/dev/null
VERSION="$(node -p "require('./package.json').version")-$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)"

echo "== package $VERSION"
TAR="$(mktemp -t gst-portal-XXXX).tgz"
tar -czf "$TAR" --exclude=node_modules --exclude=.git --exclude=data --exclude=release-build \
  --exclude='cloud/.env*' --exclude=public/tesseract \
  package.json package-lock.json CHANGELOG.md dist cloud src
echo "$VERSION" > /tmp/gst-portal-version.txt

echo "== upload"
scp -i "$KEY" -q "$TAR" "$HOST:/tmp/gst-portal.tgz"
scp -i "$KEY" -q /tmp/gst-portal-version.txt "$HOST:/tmp/gst-portal-version.txt"
rm -f "$TAR"

echo "== install on server"
$SSH "$HOST" 'set -euo pipefail
sudo rm -rf /opt/gst-portal.new && sudo mkdir -p /opt/gst-portal.new
sudo tar -xzf /tmp/gst-portal.tgz -C /opt/gst-portal.new
sudo cp /tmp/gst-portal-version.txt /opt/gst-portal.new/VERSION
cd /opt/gst-portal.new
sudo npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
sudo chown -R root:root /opt/gst-portal.new
# Config files (Caddy, systemd, backup) from the release.
sudo install -m 644 cloud/deploy/gst-portal.service /etc/systemd/system/gst-portal.service
sudo install -m 644 cloud/deploy/gst-portal-backup.service /etc/systemd/system/gst-portal-backup.service
sudo install -m 644 cloud/deploy/gst-portal-backup.timer /etc/systemd/system/gst-portal-backup.timer
sudo mkdir -p /opt/gst-portal-backup && sudo install -m 750 cloud/deploy/backup.sh /opt/gst-portal-backup/backup.sh
sudo install -m 644 cloud/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
# Swap and restart.
sudo rm -rf /opt/gst-portal.prev
[ -d /opt/gst-portal ] && sudo mv /opt/gst-portal /opt/gst-portal.prev
sudo mv /opt/gst-portal.new /opt/gst-portal
sudo systemctl enable --now gst-portal-backup.timer >/dev/null 2>&1
sudo systemctl enable gst-portal >/dev/null 2>&1
sudo systemctl restart gst-portal
sudo systemctl reload caddy || sudo systemctl restart caddy
sleep 4
systemctl is-active gst-portal
curl -fsS http://127.0.0.1:3000/api/health && echo
rm -f /tmp/gst-portal.tgz /tmp/gst-portal-version.txt'
echo "== deployed $VERSION"
