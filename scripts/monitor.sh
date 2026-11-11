#!/usr/bin/env bash
# Zurum health monitor — runs every 30 min via cron, INDEPENDENT of the app so
# it can catch the app being down. Emails OPS_ALERT_EMAIL (via Resend) when:
#   - disk is >=85% full (the classic silent killer), or
#   - https://app.zurum.co/health doesn't return 200.
# A 3-hour cooldown per alert type avoids inbox spam during an outage.
set -uo pipefail

DIR="/home/zurum/zurum"
ENV="$DIR/.env"
STATE="/var/tmp/zurum-monitor"
HEALTH_URL="https://app.zurum.co/health"
mkdir -p "$STATE"

getenv() { grep -E "^$1=" "$ENV" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//'; }
RESEND_API_KEY="$(getenv RESEND_API_KEY)"
EMAIL_FROM="$(getenv EMAIL_FROM)"; [ -z "$EMAIL_FROM" ] && EMAIL_FROM="Zurum <no-reply@zurum.co>"
TO="$(getenv OPS_ALERT_EMAIL)"

# alert <key> <subject> <html>  (deduped: max one email per key per 3h)
alert() {
  [ -z "$RESEND_API_KEY" ] || [ -z "$TO" ] && return 0
  local f="$STATE/$1"
  if [ -f "$f" ] && [ "$(( $(date +%s) - $(stat -c %Y "$f") ))" -lt 10800 ]; then return 0; fi
  touch "$f"
  curl -s -X POST https://api.resend.com/emails \
    -H "authorization: Bearer $RESEND_API_KEY" -H "content-type: application/json" \
    -d "{\"from\":\"$EMAIL_FROM\",\"to\":[\"$TO\"],\"subject\":\"$2\",\"html\":\"$3\"}" >/dev/null 2>&1 || true
}
clear_alert() { rm -f "$STATE/$1"; }

# Disk.
USE="$(df / | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
if [ "${USE:-0}" -ge 85 ]; then
  alert disk "Zurum server disk ${USE}% full" "<p>The server disk is <b>${USE}%</b> full. Clear space soon (old backups, uploads, pm2 logs) before it fills up.</p>"
else
  clear_alert disk
fi

# App health.
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$HEALTH_URL" 2>/dev/null || echo 000)"
if [ "$CODE" != "200" ]; then
  alert app "Zurum app is DOWN (health $CODE)" "<p>$HEALTH_URL returned <b>$CODE</b>. The app may be down — SSH in and check <code>pm2 status</code> / <code>pm2 restart zurum</code>.</p>"
else
  clear_alert app
fi

echo "monitor: disk=${USE}% health=$CODE"
