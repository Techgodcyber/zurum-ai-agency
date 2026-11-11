/**
 * Forge smoke test — generates a REAL website and writes it to disk so you can
 * open it in a browser. Proves the "spec → real webpage" moment end to end.
 *
 * Run: npm run smoke:forge
 * Then open the printed file path in your browser.
 */
import { generateSite } from "../src/agents/forge.js";
import { saveSite, sitePath } from "../src/sites/store.js";

const SPEC =
  "A cozy neighbourhood bakery called 'Sweet Crumbs'. Sections: hero with tagline, " +
  "about the bakery, a menu of breads/pastries/cakes with prices, a gallery, and a " +
  "contact section with address, hours, and a simple contact form. Warm, inviting " +
  "style — cream and brown palette, rounded shapes, friendly and artisanal.";

async function main() {
  console.log("Generating a real website with Forge (this calls the model)…\n");
  const t0 = Date.now();
  const site = await generateSite(SPEC);
  await saveSite("forge-demo", site.html);

  const path = sitePath("forge-demo");
  console.log(`✓ Generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  size:  ${(site.html.length / 1024).toFixed(1)} KB`);
  console.log(`  cost:  $${site.costUsd.toFixed(4)}`);
  console.log(`  valid: ${/^<!DOCTYPE html/i.test(site.html) ? "starts with <!DOCTYPE html> ✓" : "⚠️ unexpected start"}`);
  console.log(`\n  Open it →  ${path}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
