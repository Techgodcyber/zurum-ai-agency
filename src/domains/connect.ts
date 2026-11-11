import { getHosting } from "../launch/hosting-store.js";
import { setCustomDomain } from "../launch/netlify.js";
import { addPagesCustomDomain } from "../launch/cloudflare.js";

/**
 * Connect a domain the customer ALREADY owns to their live site. Free — no
 * registrar involved. We attach it on whichever host the site lives on
 * (Cloudflare Pages preferred, else Netlify), which handles SSL automatically,
 * and hand the customer the DNS record(s) to add at their registrar.
 */

/** Netlify's apex A-record target (documented load-balancer IP). */
const NETLIFY_APEX_IP = "75.2.60.5";

/** Strip a leading www. to get the apex/root domain. */
export function apexOf(domain: string): string {
  return domain.toLowerCase().trim().replace(/^www\./, "");
}

export interface ConnectResult {
  apex: string;
  www: string;
  target: string; // the host to point DNS at
  instructions: string;
}

/** Netlify DNS steps (apex A-record + www CNAME). */
function netlifyInstructions(apex: string, www: string, target: string): string {
  return [
    `Add these 2 records where your domain is managed (your registrar's DNS settings):`,
    ``,
    `  1) Type A      ·  Name: @    ·  Value: ${NETLIFY_APEX_IP}`,
    `  2) Type CNAME  ·  Name: www  ·  Value: ${target}`,
    ``,
    `Once saved (usually minutes, up to a few hours to spread worldwide), your site will be live at https://${apex} and https://${www} — with the secure padlock (https) added automatically. Your current link keeps working the whole time.`,
  ].join("\n");
}

/** Cloudflare Pages DNS steps (CNAME both apex + www to the pages.dev host). */
function cloudflareInstructions(apex: string, www: string, target: string): string {
  return [
    `Add these 2 records where your domain's DNS is managed:`,
    ``,
    `  1) Type CNAME  ·  Name: @    ·  Value: ${target}`,
    `  2) Type CNAME  ·  Name: www  ·  Value: ${target}`,
    ``,
    `Tip: if your registrar won't allow a CNAME on the root "@" (some don't), the easiest fix is to manage the domain's DNS on Cloudflare (free) — then both records work and SSL is automatic.`,
    ``,
    `Once saved (minutes, up to a few hours worldwide), your site is live at https://${apex} and https://${www}, with https added automatically. Your current link keeps working the whole time.`,
  ].join("\n");
}

/**
 * Attach the domain to the customer's site on its host and return the DNS steps.
 * Throws "site-not-deployed" if the site hasn't been published yet (nothing to
 * point the domain at).
 */
export async function connectExistingDomain(
  zurumSiteId: string,
  domain: string,
  signal?: AbortSignal,
): Promise<ConnectResult> {
  const hosting = await getHosting(zurumSiteId);
  if (!hosting) throw new Error("site-not-deployed");
  const apex = apexOf(domain);
  const www = `www.${apex}`;
  const target = hosting.publicUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

  if (hosting.provider === "cloudflare") {
    // Attach both hostnames to the Pages project; Cloudflare provisions SSL.
    await addPagesCustomDomain(hosting.providerSiteId, apex, signal);
    await addPagesCustomDomain(hosting.providerSiteId, www, signal);
    return { apex, www, target, instructions: cloudflareInstructions(apex, www, target) };
  }
  await setCustomDomain(hosting.providerSiteId, apex, [www], signal);
  return { apex, www, target, instructions: netlifyInstructions(apex, www, target) };
}
