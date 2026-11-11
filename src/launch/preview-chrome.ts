import { BRAND } from "../config/brand.js";

/**
 * Preview chrome. A FREE preview is publicly reachable on its Zurum link, so we
 * make it unusable as a real business site: a fixed "Preview — Built with
 * ${BRAND}" banner sits over it until the customer pays to publish, at which
 * point the clean version is served. The banner is a view-layer overlay injected
 * at publish time — the stored source stays clean, so publishing simply serves it
 * as-is.
 *
 * (We deliberately do NOT try to block right-click / view-source — it's trivially
 * bypassed and only annoys real visitors. The banner is what actually protects
 * revenue: no business will show customers a page stamped "PREVIEW".)
 */

const BANNER = `
<div id="zurum-preview-badge" style="
  position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
  font:600 14px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  background:linear-gradient(90deg,#0b1220,#1e3a8a);color:#fff;
  padding:10px 16px;display:flex;gap:.75rem;align-items:center;justify-content:center;
  box-shadow:0 -2px 18px rgba(0,0,0,.35);text-align:center;">
  <span>🔒 <b>PREVIEW</b> — built with ${BRAND.name}. Publish to remove this banner &amp; put it on your own domain.</span>
</div>
<style>@media print{#zurum-preview-badge{display:none}}</style>`;

/** Inject the preview banner into a page (before </body>, else append). */
export function applyPreviewChrome(html: string): string {
  if (/id=["']zurum-preview-badge["']/.test(html)) return html; // already has it
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${BANNER}</body>`);
  return html + BANNER;
}

/** The page served in place of an EXPIRED unpaid preview (recoverable on publish). */
export function expiredPreviewPage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview expired</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e6edf7;
font:16px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
.card{max-width:34rem;padding:2.5rem;text-align:center}
h1{font-size:1.6rem;margin:0 0 .6rem}
p{margin:0 0 .5rem;color:#94a3b8}
.b{margin-top:1.25rem;display:inline-block;background:#2563eb;color:#fff;padding:.7rem 1.2rem;border-radius:10px;font-weight:600}
.t{font-size:3rem;line-height:1;margin-bottom:1rem}
</style></head><body><div class="card">
<div class="t">⏳</div>
<h1>This preview has expired</h1>
<p>Your ${BRAND.name} preview was a free trial and has now expired.</p>
<p>Message ${BRAND.name} and publish it to bring your site back — permanently, on your own domain.</p>
<div class="b">Publish to restore your site</div>
</div></body></html>`;
}
