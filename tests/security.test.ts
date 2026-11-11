import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSite } from "../src/security/scan.js";
import { scoreTopup, isDisposableEmail } from "../src/billing/fraud.js";
import { getDb } from "../src/db/index.js";

// ── Security scanner (pure) ──

test("scan: clean self-contained page has no findings", () => {
  const r = scanSite(`<!doctype html><html><body><h1>Hi</h1><form action="/f/abc"></form></body></html>`);
  assert.equal(r.critical, false);
  assert.equal(r.findings.length, 0);
});

test("scan: a leaked payment secret is critical and blocks", () => {
  const r = scanSite(`<script>const k="FLWSECK-0123456789abcdef-x";</script>`);
  assert.equal(r.critical, true);
  assert.ok(r.findings.some((f) => f.type === "flutterwave-secret"));
});

test("scan: private key + stripe + aws all flagged critical", () => {
  assert.equal(scanSite("-----BEGIN RSA PRIVATE KEY-----").critical, true);
  assert.equal(scanSite('sk_live_ABCDEFGHIJKLMNOP1234').critical, true);
  assert.equal(scanSite("AKIAIOSFODNN7EXAMPLE").critical, true);
});

test("scan: insecure form + mixed content are warnings, not blocking", () => {
  const r = scanSite(`<form action="http://evil.test/collect"></form><img src="http://x.test/a.png">`);
  assert.equal(r.critical, false);
  assert.ok(r.findings.some((f) => f.type === "insecure-form"));
  assert.ok(r.findings.some((f) => f.type === "mixed-content"));
});

test("scan: localhost http assets are not counted as mixed content", () => {
  const r = scanSite(`<img src="http://localhost:3000/a.png">`);
  assert.ok(!r.findings.some((f) => f.type === "mixed-content"));
});

// ── Fraud scoring ──

test("fraud: disposable email domains are recognised", () => {
  assert.equal(isDisposableEmail("a@mailinator.com"), true);
  assert.equal(isDisposableEmail("a@mail7.io"), true);
  assert.equal(isDisposableEmail("real@gmail.com"), false);
  assert.equal(isDisposableEmail(null), false);
});

test("fraud: a fresh user's first top-up is allowed", async () => {
  const db = await getDb();
  const [u] = await db.query<{ id: string }>(
    `INSERT INTO users (channel) VALUES ('telegram') RETURNING id`,
  );
  const v = await scoreTopup({ userId: u!.id, amount: 5, currency: "USD" });
  // A brand-new account gets a small "young account" nudge, but with no velocity
  // it stays well under the review threshold and is allowed through.
  assert.equal(v.action, "allow");
  assert.ok(v.score < 40, `score ${v.score} should be below review threshold`);
});

test("fraud: rapid-fire checkouts trip the card-testing block", async () => {
  const db = await getDb();
  const [u] = await db.query<{ id: string }>(
    `INSERT INTO users (channel) VALUES ('telegram') RETURNING id`,
  );
  for (let i = 0; i < 9; i++) {
    await db.query(
      `INSERT INTO topups (user_id, tx_ref, credits, amount, currency) VALUES ($1, $2, 50, 5, 'USD')`,
      [u!.id, `t-${u!.id.slice(0, 6)}-${i}`],
    );
  }
  const v = await scoreTopup({ userId: u!.id, amount: 5, currency: "USD" });
  assert.equal(v.action, "block");
  assert.ok(v.score >= 80, `score ${v.score} should be >= 80`);
  assert.ok(v.reasons.some((r) => /card-testing/.test(r)));
});
