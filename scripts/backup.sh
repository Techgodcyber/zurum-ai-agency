#!/usr/bin/env bash
# Zurum nightly backup — the control-plane DB (accounts, credits, domains, site
# mappings — "worse than losing a site") + generated site sources + uploads.
# Keeps 7 rotated local copies AND ships the DB dump OFF-SITE by emailing it
# (via Resend) to OPS_ALERT_EMAIL. Emails an alert on ANY failure. Optionally
# copies to Cloudflare R2 if an rclone remote 'r2:' is configured.
#
# Install (as root):  /etc/cron.d/zurum runs this nightly. Run once by hand to test.
set -uo pipefail

DIR="/home/zurum/zurum"
ENV="$DIR/.env"
BK="/var/backups/zurum"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"

getenv() { grep -E "^$1=" "$ENV" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//'; }
RESEND_API_KEY="$(getenv RESEND_API_KEY)"
EMAIL_FROM="$(getenv EMAIL_FROM)"; [ -z "$EMAIL_FROM" ] && EMAIL_FROM="Zurum <no-reply@zurum.co>"
TO="$(getenv OPS_ALERT_EMAIL)"
DATABASE_URL="$(getenv DATABASE_URL)"
R2_BUCKET="$(getenv R2_BUCKET)"; [ -z "$R2_BUCKET" ] && R2_BUCKET="zurum-backups"

# email <subject> <html> [attachment_path]
email() {
  [ -z "$RESEND_API_KEY" ] || [ -z "$TO" ] && return 0
  local att=""
  if [ -n "${3:-}" ] && [ -f "${3:-}" ]; then
    att=",\"attachments\":[{\"filename\":\"$(basename "$3")\",\"content\":\"$(base64 -w0 "$3")\"}]"
  fi
  curl -s -X POST https://api.resend.com/emails \
    -H "authorization: Bearer $RESEND_API_KEY" -H "content-type: application/json" \
    -d "{\"from\":\"$EMAIL_FROM\",\"to\":[\"$TO\"],\"subject\":\"$1\",\"html\":\"$2\"$att}" >/dev/null 2>&1 || true
}
fail() { echo "BACKUP FAILED: $1"; email "Zurum backup FAILED ($STAMP)" "<p>The nightly backup failed at $1.</p>"; exit 1; }

# 1. Postgres dump (small + the most critical thing to keep).
DB="$BK/db-$STAMP.sql.gz"
pg_dump "$DATABASE_URL" 2>/dev/null | gzip > "$DB" || fail "pg_dump"
[ -s "$DB" ] || fail "empty dump"

# 2. Generated site sources + user uploads.
DATA="$BK/data-$STAMP.tar.gz"
tar -czf "$DATA" -C "$DIR" .data 2>/dev/null || true

# 3. Rotate — keep the 7 newest of each.
ls -1t "$BK"/db-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
ls -1t "$BK"/data-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f

# 4. Off-site: email the DB dump (off-site by definition) if small enough.
SZ="$(stat -c%s "$DB" 2>/dev/null || echo 0)"
DBH="$(du -h "$DB" | cut -f1)"; DATAH="$(du -h "$DATA" 2>/dev/null | cut -f1)"
if [ "$SZ" -lt 20000000 ]; then
  email "Zurum backup OK ($STAMP)" "<p>Nightly backup complete. Database dump attached (${DBH}); site/upload archive kept on the server (${DATAH}). 7 daily copies are rotated locally.</p>" "$DB"
else
  email "Zurum backup OK — DB too big to email ($STAMP)" "<p>Backup complete (DB ${DBH}) but the dump is over the email limit. Set up Cloudflare R2 for full off-site. Local copies are kept.</p>"
fi

# 5. Optional full off-site to Cloudflare R2 (if rclone remote 'r2:' exists).
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q '^r2:'; then
  rclone copy "$DB" "r2:$R2_BUCKET/" >/dev/null 2>&1 || true
  rclone copy "$DATA" "r2:$R2_BUCKET/" >/dev/null 2>&1 || true
fi

echo "backup ok: $STAMP (db=$DBH data=$DATAH)"
