import { setDefaultResultOrder } from "node:dns";
// Prefer IPv4. On networks with broken/slow IPv6 or NAT64, Node resolving a host
// to an unreachable IPv6 address makes outbound calls (Vonage, providers) hang
// until timeout. Matching the reachable address family avoids that stall.
setDefaultResultOrder("ipv4first");

import { logger } from "./lib/logger.js";
import { availableProviders } from "./models/index.js";
import { ChannelHub } from "./channels/index.js";
import { ZurumApp } from "./app.js";
import { BRAND } from "./config/brand.js";
import { startPreviewServer, BASE_URL } from "./web/preview-server.js";
import { hostLabel } from "./launch/deploy.js";
import { loadSettings } from "./config/settings.js";
import { initAdmin } from "./admin/server.js";
import { startPreviewSweep } from "./launch/preview-sweep.js";
import { purgeOldEvents } from "./growth/analytics.js";

/**
 * Entry point. Boots the app: starts Maestro, then starts every configured
 * channel (Telegram today; WhatsApp/web slot in later) behind the app's inbound
 * handler. With a TELEGRAM_BOT_TOKEN set, this is a live bot you can message.
 */
async function main() {
  const log = logger.child({ mod: "boot" });
  log.info(
    {
      providers: availableProviders(),
      hosting: hostLabel(),
    },
    `${BRAND.name} starting`,
  );

  if (availableProviders().length === 0) {
    log.warn("no model providers configured — set ANTHROPIC_API_KEY in .env");
  }

  await loadSettings(); // apply any runtime overrides for limits/pricing
  await initAdmin(); // session housekeeping + first-run notice
  startPreviewSweep(); // optional: expire old unpaid previews (off unless configured)
  // Analytics retention: drop pageview events past the window, daily.
  void purgeOldEvents().catch(() => {});
  setInterval(() => void purgeOldEvents().catch(() => {}), 24 * 60 * 60 * 1000).unref();

  const hub = new ChannelHub();
  const app = new ZurumApp(hub);
  // The web server needs the hub so form submissions can ping the site owner.
  startPreviewServer(hub);
  await app.recoverOnBoot(); // unstick anything orphaned by the last restart
  app.start();
  await hub.start(app.handleInbound);

  log.info({ previews: BASE_URL, admin: `${BASE_URL}/admin` }, "boot complete");
}

main().catch((err) => {
  logger.error({ err }, "fatal on boot");
  process.exit(1);
});
