/**
 * Edit smoke test: takes the existing generated site and applies a real change,
 * proving Forge edits (not canned replies). Run smoke:forge first.
 *
 * Run: npm run smoke:edit
 */
import { editSite } from "../src/agents/forge.js";
import { review } from "../src/agents/guardian.js";
import { readSite } from "../src/sites/store.js";

async function main() {
  const before = await readSite("forge-demo");
  if (!before) {
    console.error("Run `npm run smoke:forge` first.");
    process.exit(1);
  }

  console.log('Applying edit: "make the whole page background green"…\n');
  const t0 = Date.now();
  const { html, costUsd } = await editSite(before, "make the whole page background green");
  const report = await review(html);

  const changed = html !== before;
  const valid = /^<!DOCTYPE html/i.test(html.trim());
  const selfContained = !/(?:src|href)\s*=\s*["']https?:\/\//i.test(html);
  const mentionsGreen = /green|#[0-9a-f]{0,2}[0-9a-f]0[0-9a-f]{0,2}/i.test(html);

  console.log(`✓ edited in ${((Date.now() - t0) / 1000).toFixed(1)}s, cost $${costUsd.toFixed(4)}`);
  console.log(`  changed:          ${changed ? "PASS" : "FAIL"}`);
  console.log(`  still valid HTML: ${valid ? "PASS" : "FAIL"}`);
  console.log(`  self-contained:   ${selfContained ? "PASS" : "FAIL"}`);
  console.log(`  mentions green:   ${mentionsGreen ? "PASS" : "(not detected — check visually)"}`);
  console.log(`  guardian passes:  ${report.passed ? "PASS" : "FAIL — " + report.issues.join("; ")}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
