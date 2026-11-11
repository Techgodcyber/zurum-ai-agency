import { generateSite, editSite } from "../agents/forge.js";
import { review, staticChecks } from "../agents/guardian.js";
import { scanSite } from "../security/scan.js";
import { saveSite, readSite, saveSiteFiles, readSiteFiles, copySite } from "../sites/store.js";
import { resolveSiteHtml } from "../sites/resolve.js";
import { getLogo, clearLogo } from "../media/logos.js";
import { imagePaletteFor } from "../media/images.js";
import { captureFullSite } from "../media/clone.js";
import { fetchBlueprint, blueprintToBrief } from "../media/webref.js";
import { detectPlan, setSitePlan, isPublished } from "../billing/publish.js";
import { applyPreviewChrome } from "../launch/preview-chrome.js";
import { previewUrlFor, formEndpointFor, BASE_URL } from "../web/preview-server.js";
import { isHostConfigured, publishSiteFiles } from "../launch/deploy.js";
import { injectBackendSdk, injectTracker } from "../backend/sdk.js";
import { wireClonedAuth } from "../backend/clone-wire.js";
import { logger } from "../lib/logger.js";
import type { Step, StepContext } from "./types.js";

const log = logger.child({ mod: "pipeline" });

/**
 * Pipelines the customer's request flows through (§5). Two today:
 *   BUILD: intake → build → qa → [HUMAN APPROVAL] → deploy
 *   EDIT:  edit  →        qa → [HUMAN APPROVAL] → deploy
 * The qa / approval / deploy steps are shared between them.
 */

// ── Shared steps ─────────────────────────────────────────

/** The stable site id for a job — the preview URL is built from this. */
function siteIdOf(input: Record<string, unknown>, fallback: string): string {
  return (input["siteId"] as string | undefined) ?? fallback;
}

/** The customer's uploaded logo (if any) for this job's chat. */
function logoFor(input: Record<string, unknown>): Promise<string | null> {
  const channel = input["channel"] as string | undefined;
  const chatId = input["chatId"] as string | undefined;
  return channel && chatId ? getLogo(channel, chatId) : Promise.resolve(null);
}

/** Clear a used logo so it never bleeds onto the customer's NEXT (different) site. */
async function forgetLogo(input: Record<string, unknown>): Promise<void> {
  const channel = input["channel"] as string | undefined;
  const chatId = input["chatId"] as string | undefined;
  if (channel && chatId) await clearLogo(channel, chatId).catch(() => {});
}

/** Run the normal Forge generation for a spec/brief and save the result. */
async function runForge(ctx: StepContext, spec: string, backend = false): Promise<{ bytes: number }> {
  const logo = await logoFor(ctx.job.input);
  const siteId = siteIdOf(ctx.job.input, ctx.job.id);
  // Fetch real stock photos for the brief (empty when Pexels isn't set up).
  let palette: Awaited<ReturnType<typeof imagePaletteFor>> = [];
  try {
    palette = await imagePaletteFor(spec, ctx.signal);
  } catch (err) {
    log.warn({ err }, "image palette failed — building without photos");
  }
  // Real form endpoint so contact/booking forms actually capture leads.
  const site = await generateSite(
    spec,
    ctx.signal,
    logo,
    palette,
    formEndpointFor(siteId),
    backend,
  );
  let html = site.html;
  // A dynamic site is BUILT with its login/dashboard UI + the self-contained
  // auth runtime injected — but the backend itself stays OFF until the customer
  // pays to publish (markPublished enables it). So the preview shows the real
  // UI; accounts only start working once it's paid for (publish-to-pay).
  if (backend) {
    html = injectBackendSdk(html, siteId, BASE_URL);
    log.info({ siteId }, "backend runtime injected (dynamic site; activates on publish)");
  }
  await saveSite(ctx.job.id, html);
  if (logo) await forgetLogo(ctx.job.input); // consumed — don't reuse on the next site
  ctx.addCost(site.costUsd, site.tokens);
  return { bytes: html.length };
}

/** Distil a reference site into a rebuild brief (fallback when cloning fails). */
async function blueprintBrief(url: string, signal?: AbortSignal): Promise<string> {
  try {
    const bp = await fetchBlueprint(url);
    return blueprintToBrief(bp, true);
  } catch {
    return "a clean, professional business website";
  }
}

/**
 * Guardian gate — checks the JOB's working copy (never the live site). A failed
 * edit therefore never corrupts the customer's current good version.
 */
const qaStep: Step = {
  name: "qa",
  async run(ctx) {
    const html = await readSite(ctx.job.id);
    if (!html) throw new Error("qa: no generated site found to review");
    // Allow external resources for CLONES (they reference the original's real
    // images/CSS and have all scripts stripped) — both a fresh clone build and an
    // edit of a site that was cloned (its base already has external resources).
    const allowExternal =
      Boolean(ctx.job.input["cloneUrl"]) || ctx.data["clonedBase"] === true;
    // Deterministic security scan (§14.4) — cheap, no model, gates every publish.
    // A leaked real secret blocks the build outright; everything else is a warning
    // that rides along in qaIssues so it surfaces without stopping the customer.
    const scan = scanSite(html);
    if (scan.critical) {
      const crit = scan.findings.filter((f) => f.severity === "critical").map((f) => f.detail);
      throw new Error(`Security scan blocked the build (possible leaked secret): ${crit.join("; ")}`);
    }
    const securityWarnings = scan.findings
      .filter((f) => f.severity !== "info")
      .map((f) => `security: ${f.detail}`);

    const report = await review(html, ctx.signal, allowExternal);
    ctx.addCost(report.costUsd, 0);
    if (report.critical) {
      throw new Error(`Guardian blocked the build: ${report.issues.join("; ")}`);
    }
    const issues = [...report.issues, ...securityWarnings];
    return {
      qa: report.passed && !securityWarnings.length ? "passed" : "passed-with-warnings",
      qaIssues: issues,
    };
  },
};

/**
 * Promote the verified working copy to the STABLE site id, then publish it to
 * real hosting so the customer's preview URL is a genuinely public link they can
 * open and share from any device (a LAN URL is useless to a remote customer).
 * Deploying here — before the approval gate — is deliberate: the customer must
 * be able to actually SEE the preview to decide on it. Netlify deploys are free
 * and content-addressed, so re-deploying an unchanged site is a no-op.
 *
 * Only a Guardian-approved working copy ever reaches this step, so a failed edit
 * never touches the live site. Without NETLIFY_TOKEN, falls back to the LAN URL.
 */
const promoteStep: Step = {
  name: "promote",
  async run(ctx) {
    const siteId = siteIdOf(ctx.job.input, ctx.job.id);
    await copySite(ctx.job.id, siteId);
    const lanUrl = previewUrlFor(siteId);

    if (!isHostConfigured()) return { previewUrl: lanUrl, live: false };
    try {
      // Read EVERY page (a clone may have login/register/… as well as the home
      // page); single-page sites come back as a one-entry map, handled the same.
      const files = await readSiteFiles(siteId);
      if (!files) return { previewUrl: lanUrl, live: false };
      // A free (unpublished) preview gets the "Preview — Built with Zurum" banner
      // on every page; a paid/published site is served clean.
      const published = await isPublished(siteId);
      const toServe = new Map<string, string>();
      for (const [path, html] of files) {
        // Every published page gets the privacy-friendly analytics beacon.
        const withTracker = injectTracker(html, siteId, BASE_URL);
        toServe.set(path, published ? withTracker : applyPreviewChrome(withTracker));
      }
      const { url } = await publishSiteFiles(siteId, toServe, ctx.signal);
      return { previewUrl: url, lanUrl, live: true };
    } catch (err) {
      // Never fail the whole job over hosting — serve the LAN preview instead.
      log.error({ err, siteId }, "host deploy failed; serving LAN preview");
      return { previewUrl: lanUrl, live: false };
    }
  },
};

/** HUMAN APPROVAL — the customer confirms the (already-viewable) preview. */
const approvalStep: Step = { name: "approval", gate: true };

/**
 * Finalise. The site is already published (promoteStep), so this just records
 * the public URL as the deployed URL and carries the live flag through.
 */
const deployStep: Step = {
  name: "deploy",
  async run(ctx) {
    const siteId = siteIdOf(ctx.job.input, ctx.job.id);
    // If the site is now published (payment cleared the approval gate), re-serve
    // the CLEAN version so the preview banner is gone. Promote served the banner
    // version while it was still an unpaid preview.
    if (ctx.data["live"] && (await isPublished(siteId))) {
      try {
        const files = await readSiteFiles(siteId);
        if (files) {
          const clean = new Map<string, string>();
          for (const [path, html] of files) clean.set(path, injectTracker(html, siteId, BASE_URL));
          await publishSiteFiles(siteId, clean, ctx.signal);
        }
      } catch (err) {
        log.warn({ err, siteId }, "deploy: clean re-publish failed (banner may linger)");
      }
    }
    return {
      deployedUrl: (ctx.data["previewUrl"] as string | undefined) ?? previewUrlFor(siteId),
      live: ctx.data["live"] ?? false,
    };
  },
};

// ── BUILD pipeline ───────────────────────────────────────
// Note: Scribe already produced the spec during the chat, so the build step
// uses it directly — no redundant intake model call here.
export const BUILD_PIPELINE: Step[] = [
  {
    name: "build",
    async run(ctx) {
      const spec =
        (ctx.job.input["description"] as string) ?? "a simple business website";
      // Classify the pricing tier (static vs dashboard/dynamic) for the publish
      // fee — covers both the clone and the Forge path. A dynamic site also gets
      // the real backend (working login/accounts/dashboard).
      const plan = detectPlan(spec);
      await setSitePlan(siteIdOf(ctx.job.input, ctx.job.id), plan).catch(() => {});

      // HIGH-FIDELITY CLONE: when the customer confirmed they own a site, copy
      // the REAL page (rendered HTML + CSS + images) rather than having Forge
      // reimagine it from a summary. Falls back to the blueprint rebuild if the
      // page can't be rendered.
      const cloneUrl = ctx.job.input["cloneUrl"] as string | undefined;
      if (cloneUrl) {
        try {
          // Crawl the source's own pages (home + login + register + about …) and
          // rehost each — so a real multi-page site is copied WHOLE, not just its
          // front page. Falls back to the blueprint rebuild if nothing renders.
          const files = await captureFullSite(cloneUrl, ctx.signal);
          const siteId = siteIdOf(ctx.job.input, ctx.job.id);
          // If the cloned site has login/register forms, wire them to the Zurum
          // backend so they actually work once published (dynamic tier). The
          // backend itself only turns on at publish (markPublished), same as
          // Forge-built dynamic sites — publish-to-pay.
          let hasAuth = false;
          const out = new Map<string, string>();
          for (const [p, h] of files) {
            const w = wireClonedAuth(h);
            hasAuth = hasAuth || w.hasAuth;
            out.set(p, w.html);
          }
          if (hasAuth) {
            await setSitePlan(siteId, "dynamic").catch(() => {});
            for (const [p, h] of out) out.set(p, injectBackendSdk(h, siteId, BASE_URL));
            log.info({ cloneUrl, siteId }, "clone has auth forms — wired to backend (activates on publish)");
          }
          await saveSiteFiles(ctx.job.id, out);
          const bytes = [...out.values()].reduce((n, h) => n + h.length, 0);
          log.info({ cloneUrl, pages: out.size, bytes, hasAuth }, "build: high-fidelity clone");
          return { bytes, cloned: true, pages: out.size, dynamic: hasAuth };
        } catch (err) {
          log.warn({ err, cloneUrl }, "clone failed — falling back to blueprint rebuild");
          const brief = await blueprintBrief(cloneUrl, ctx.signal);
          return runForge(ctx, brief);
        }
      }

      // Forge generates the site into the JOB's working copy; promoteStep
      // publishes it to the stable URL after Guardian approves. Dynamic sites
      // get the real backend wired in.
      return runForge(ctx, spec, plan === "dynamic");
    },
  },
  qaStep,
  promoteStep,
  approvalStep,
  deployStep,
];

// ── EDIT pipeline ────────────────────────────────────────
export const EDIT_PIPELINE: Step[] = [
  {
    name: "edit",
    async run(ctx) {
      // Read the CURRENT live version (stable id), apply the change into the
      // JOB's working copy. The live site is only updated once Guardian passes
      // (promoteStep) — a failed edit never corrupts the good version.
      const siteId = siteIdOf(ctx.job.input, ctx.job.id);
      const change =
        (ctx.job.input["description"] as string) ?? "improve the site";
      // Resolve from local OR the live deployed URL, so a missing local copy
      // (data reset, etc.) never breaks edits on a site that is clearly live.
      const current = await resolveSiteHtml(siteId);
      if (!current) throw new Error("edit: current site not found");
      // If the live site already references external resources (i.e. it was a
      // clone), let QA allow them on the edited copy too — otherwise a harmless
      // edit would be blocked by the self-containment rule.
      if (staticChecks(current, false).issues.some((i) => i.includes("external resource"))) {
        ctx.data["clonedBase"] = true;
      }
      const logo = await logoFor(ctx.job.input);
      const site = await editSite(current, change, ctx.signal, logo);
      await saveSite(ctx.job.id, site.html);
      if (logo) await forgetLogo(ctx.job.input); // consumed — don't reuse on the next site
      ctx.addCost(site.costUsd, site.tokens);
      return { bytes: site.html.length };
    },
  },
  qaStep,
  promoteStep,
  approvalStep,
  deployStep,
];
