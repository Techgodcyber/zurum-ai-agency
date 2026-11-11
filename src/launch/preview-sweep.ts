import { getNum } from "../config/settings.js";
import { expiredPreviewIds, markExpired } from "../billing/publish.js";
import { publishSite } from "./deploy.js";
import { expiredPreviewPage } from "./preview-chrome.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "preview-sweep" });

/**
 * Optional preview expiry. When `preview_expiry_hours` > 0, unpaid previews older
 * than that window are replaced with a friendly "publish to restore" page. It's
 * RECOVERABLE — publishing (paying) re-serves the real site — so it nudges
 * without permanently destroying a warm lead. Off by default.
 */
export async function sweepExpiredPreviews(): Promise<void> {
  const hours = getNum("preview_expiry_hours");
  if (hours <= 0) return; // disabled
  const ids = await expiredPreviewIds(hours);
  if (!ids.length) return;
  const page = expiredPreviewPage();
  for (const siteId of ids) {
    try {
      await publishSite(siteId, page);
      await markExpired(siteId);
      log.info({ siteId, hours }, "preview expired — replaced with restore page");
    } catch (err) {
      log.warn({ err, siteId }, "failed to expire preview");
    }
  }
}

/** Start the periodic sweep. The setting is re-read each run, so 0 = no-op. */
export function startPreviewSweep(): NodeJS.Timeout {
  const timer = setInterval(() => void sweepExpiredPreviews().catch(() => {}), 30 * 60_000);
  timer.unref?.(); // don't keep the process alive just for this
  return timer;
}
