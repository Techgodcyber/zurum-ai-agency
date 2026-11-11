#!/usr/bin/env bash
# Zurum VPS provisioning — Ubuntu 24.04, tuned for a 4 GB droplet.
# Run as root on a FRESH server:  bash provision.sh
# Idempotent-ish: safe to re-run. Does OS-level setup; the app deploy (clone,
# .env, build, pm2, nginx, HTTPS) is the second half — see scripts/deploy.sh.
set -euo pipefail

APP_USER=zurum

echo "──> 1/6  Swap (critical on 4 GB — cushions Chromium/Postgres spikes)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo 'vm.swappiness=10' >>/etc/sysctl.conf
  sysctl vm.swappiness=10
  echo "    2 GB swap on."
else
  echo "    swap already present — skipping."
fi

echo "──> 2/6  Base packages + Node 24 + Postgres + nginx + certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ufw nginx postgresql certbot python3-certbot-nginx ca-certificates
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
npm i -g pm2 >/dev/null 2>&1 || npm i -g pm2

echo "──> 3/6  Firewall (SSH + HTTP/HTTPS only)"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
echo "    ufw enabled."

echo "──> 4/6  App user '$APP_USER'"
id -u "$APP_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$APP_USER"

echo "──> 5/6  Postgres database + user"
DB_PASS_FILE=/root/.zurum_db_pass
if [ ! -f "$DB_PASS_FILE" ]; then
  openssl rand -hex 24 >"$DB_PASS_FILE"
  chmod 600 "$DB_PASS_FILE"
fi
DB_PASS="$(cat "$DB_PASS_FILE")"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='zurum'" | grep -q 1 ||
  sudo -u postgres psql -c "CREATE USER zurum WITH PASSWORD '${DB_PASS}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='zurum'" | grep -q 1 ||
  sudo -u postgres psql -c "CREATE DATABASE zurum OWNER zurum;"
echo "    DATABASE_URL=postgres://zurum:${DB_PASS}@localhost:5432/zurum"
echo "    (also saved in $DB_PASS_FILE)"

echo "──> 6/6  Headless Chromium (for high-fidelity site cloning)"
# Installed per-app after clone via 'npx playwright install --with-deps chromium';
# here we just pull the shared system libraries it needs.
apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 \
  libpango-1.0-0 libcairo2 fonts-liberation >/dev/null 2>&1 || true

echo ""
echo "✅ OS provisioning done. Next: deploy the app (scripts/deploy.sh) — clone the"
echo "   repo as '$APP_USER', add .env (incl. the DATABASE_URL above and"
echo "   PUBLIC_BASE_URL=https://app.zurum.co), npm ci, playwright install, build,"
echo "   pm2 start, then nginx + certbot for app.zurum.co."
