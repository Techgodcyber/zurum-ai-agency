#!/usr/bin/env bash
# Zurum app deploy — run as the 'zurum' user AFTER scripts/provision.sh.
# First run clones + builds + starts; re-runs pull + rebuild + restart.
#   su - zurum
#   bash deploy.sh
set -euo pipefail

REPO="https://github.com/Techgodcyber/zurum.git"
DIR="$HOME/zurum"
DOMAIN="app.zurum.co"

if [ ! -d "$DIR/.git" ]; then
  echo "──> Cloning (you'll be asked for GitHub credentials — use a Personal"
  echo "    Access Token as the password, since the repo is private)."
  git clone "$REPO" "$DIR"
  cd "$DIR"
  cp -n .env.example .env
  echo ""
  echo "⚠  Edit ~/zurum/.env now: paste your keys, set NODE_ENV=production,"
  echo "   DATABASE_URL (from provisioning), and PUBLIC_BASE_URL=https://$DOMAIN"
  echo "   Re-run this script once .env is filled in."
  exit 0
fi

cd "$DIR"
echo "──> Pulling latest + installing"
git pull --ff-only
npm ci
echo "──> Installing Chromium for cloning (first run only, ~1 min)"
npx playwright install chromium >/dev/null 2>&1 || npx playwright install --with-deps chromium
echo "──> Building"
npm run build
echo "──> Starting under pm2"
pm2 describe zurum >/dev/null 2>&1 && pm2 restart zurum || pm2 start dist/src/index.js --name zurum
pm2 save
echo ""
echo "✅ App running. If this is the first run, finish networking as ROOT:"
echo "   1. Point DNS: an A record for $DOMAIN → this server's IP (Cloudflare, DNS-only/grey-cloud first)."
echo "   2. Configure nginx + HTTPS:"
echo "        sudo tee /etc/nginx/sites-available/zurum >/dev/null <<'NGINX'"
echo "        server {"
echo "          server_name $DOMAIN;"
echo "          client_max_body_size 12M;"
echo "          location / {"
echo "            proxy_pass http://127.0.0.1:3000;"
echo "            proxy_set_header Host \$host;"
echo "            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
echo "            proxy_set_header X-Forwarded-Proto \$scheme;"
echo "            proxy_read_timeout 300s;"
echo "          }"
echo "        }"
echo "        NGINX"
echo "        sudo ln -sf /etc/nginx/sites-available/zurum /etc/nginx/sites-enabled/"
echo "        sudo nginx -t && sudo systemctl reload nginx"
echo "        sudo certbot --nginx -d $DOMAIN"
echo "   3. pm2 startup   (run the command it prints, so Zurum survives reboots)"
