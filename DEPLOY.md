# Deploying Zurum to a VPS

Everything Zurum needs to run 24/7: the Telegram/WhatsApp bot, the admin control
centre, the form endpoint for customer sites, and (once public) payment webhooks.

Customer **websites** are hosted separately on Cloudflare Pages — this server runs
Zurum itself.

---

## 1. What to buy

Any Ubuntu 22.04/24.04 VPS with **2 GB RAM** is plenty to start
(Hostinger / Contabo / DigitalOcean, ~$5–12/month). You also need a domain or
subdomain for the bot, e.g. `app.yourdomain.com` — point its DNS **A record** at
the VPS IP (proxied through Cloudflare is fine and recommended).

---

## 2. Server setup (once)

```bash
# as root
adduser zurum && usermod -aG sudo zurum
# harden: SSH keys only, no root login, firewall
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable

# Node 24 + git + postgres + nginx + certbot
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs git postgresql nginx certbot python3-certbot-nginx
npm i -g pm2
```

### Headless browser (for high-fidelity site cloning)

The "recreate my existing site" feature renders the real page in Chromium, so the
server needs it plus its system libraries:

```bash
cd ~/zurum
npx playwright install --with-deps chromium   # browser + Linux deps
```

> If Chromium isn't installed, cloning simply falls back to the blueprint rebuild
> — nothing crashes — but install it to get the ~90% high-fidelity clones.

### Postgres (replaces the embedded dev database)

```bash
sudo -u postgres psql -c "CREATE USER zurum WITH PASSWORD 'CHANGE_ME_STRONG';"
sudo -u postgres psql -c "CREATE DATABASE zurum OWNER zurum;"
# → DATABASE_URL=postgres://zurum:CHANGE_ME_STRONG@localhost:5432/zurum
```

> The schema applies itself on boot (`SCHEMA_SQL`), so there is no migration step.

---

## 3. Deploy the app

```bash
su - zurum
git clone https://github.com/Techgodcyber/zurum.git && cd zurum
npm ci
cp .env.example .env   # then paste your real keys (see §4)
npm run build
pm2 start dist/index.js --name zurum
pm2 save && pm2 startup     # run the command it prints, so it survives reboots
```

Updating later:

```bash
cd ~/zurum && git pull && npm ci && npm run build && pm2 restart zurum
```

---

## 4. `.env` on the server

Copy every key from your local `.env`, then **change/add these**:

```ini
NODE_ENV=production
DATABASE_URL=postgres://zurum:CHANGE_ME_STRONG@localhost:5432/zurum
PUBLIC_BASE_URL=https://app.yourdomain.com   # ← critical: forms, admin, webhooks
PORT=3000
```

`PUBLIC_BASE_URL` is what makes generated forms, the admin centre and payment
webhooks reachable from the internet — set it before the first build.

---

## 5. Nginx + HTTPS

```nginx
# /etc/nginx/sites-available/zurum
server {
  server_name app.yourdomain.com;
  client_max_body_size 12M;          # logo/image uploads
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;         # long AI builds
  }
}
```

```bash
ln -s /etc/nginx/sites-available/zurum /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d app.yourdomain.com     # free HTTPS
```

---

## 6. Securing the admin control centre

Bots scan `/admin`, `/wp-admin`, `/administrator` around the clock. Zurum defends
in layers — set these **before** the panel is publicly reachable:

```ini
# 1. SECRET PATH — the panel lives here; every other path 404s, so scanners
#    never learn it exists. Use something unguessable.
ADMIN_PATH=/console-8f3k2p9x

# 2. IP ALLOWLIST (strongest single control if your team has fixed IPs).
#    Anything not listed gets a plain 404. Leave blank to disable.
ADMIN_IP_ALLOWLIST=41.x.x.x,102.x.x.x

# 3. LOGIN LOCKOUT (on by default) — escalating backoff, keyed on BOTH the IP
#    and the account, so spraying and distributed guessing are both stopped.
ADMIN_MAX_LOGIN_ATTEMPTS=5
ADMIN_LOCKOUT_MINUTES=15
```

> **Be honest about what each does:** the secret path is a *noise filter* — it
> removes ~all automated scanning. The **lockout** is what actually stops a
> determined attacker guessing passwords, and the **IP allowlist** is the
> strongest control of the three. Use long unique passwords for every staff
> account regardless.

Also already enforced: `noindex` on admin pages, HttpOnly + SameSite=Strict
session cookies (auto-`Secure` over HTTPS), generic login errors that never
reveal whether an account exists, and a full audit log of every action.

## 7. First run

1. Open `https://app.yourdomain.com<ADMIN_PATH>` → create the **owner** account
   (this page only appears once, while no staff exist).
2. Add your team under **Staff** and give each person a role.
3. Check **Settings** for pricing/limits, and **Sites** for the kill switch.

---

## 8. What hosting unlocks

| Now possible | Why |
|---|---|
| **Flutterwave webhook** | Credits land automatically after a bank transfer — set the webhook to `https://app.yourdomain.com/pay/webhook` once implemented |
| **WhatsApp (Vonage)** | Vonage delivers inbound messages to a public webhook — see §8.1 |
| **Working forms on customer sites** | They POST to `PUBLIC_BASE_URL/f/<siteId>` |
| **24/7 availability** | Customers can build at any hour |

### 8.1 Connecting WhatsApp (Vonage)

**Sending** works with just credentials — no public URL. **Receiving** needs
Vonage to reach a public webhook, which is why full WhatsApp needs hosting (or a
tunnel for local testing).

**To test today without the VPS** (Vonage WhatsApp *sandbox*):
1. Vonage dashboard → **Messages API Sandbox** → whitelist your own WhatsApp by
   sending the shown join code to the sandbox number.
2. In `.env`: set `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `VONAGE_SANDBOX=true`,
   `VONAGE_WHATSAPP_NUMBER=14157386102`.
3. Expose the local server with a tunnel and set that as the sandbox **Inbound**
   webhook (append the path from the boot log):
   ```bash
   cloudflared tunnel --url http://localhost:3000
   # → https://xxxx.trycloudflare.com/webhooks/whatsapp/<TOKEN>/inbound
   ```

**In production (VPS):**
- Point a Vonage **Application**'s Messages inbound webhook at
  `https://app.yourdomain.com/webhooks/whatsapp/<VONAGE_WEBHOOK_TOKEN>/inbound`
  and set `VONAGE_SANDBOX=false` with your approved WhatsApp Business number in
  `VONAGE_WHATSAPP_NUMBER`.
- The boot log prints the exact webhook URL to register.

> Outside WhatsApp's 24-hour customer-service window you may only send
> pre-approved template messages (renewal reminders, "site ready"). Free-form
> replies work within 24h of the customer's last message.

---

## 9. Backups (do this on day one)

```bash
# nightly DB dump + generated sites, keep 14 days
0 3 * * * pg_dump -U zurum zurum | gzip > ~/backups/zurum-$(date +\%F).sql.gz
0 4 * * * tar czf ~/backups/sites-$(date +\%F).tgz ~/zurum/.data/sites
0 5 * * * find ~/backups -mtime +14 -delete
```

Also keep the VPS provider's snapshot feature on — it is the cheapest insurance
you will ever buy.

---

## 10. Health

- `GET /health` → `ok` (use for uptime monitoring, e.g. UptimeRobot)
- `pm2 logs zurum` → live logs
- `pm2 monit` → CPU/memory
