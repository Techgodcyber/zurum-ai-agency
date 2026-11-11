import { test } from "node:test";
import assert from "node:assert/strict";
import { wireClonedAuth } from "../src/backend/clone-wire.js";
import { saveUpload, getUpload } from "../src/backend/uploads.js";
import {
  registerUser,
  authenticateUser,
  createSession,
  userForToken,
  destroySession,
  createRecord,
  listRecords,
  updateRecord,
  deleteRecord,
  enableSiteBackend,
  getSiteBackend,
  createPasswordReset,
  resetPassword,
  listSiteUsers,
  createEmailVerification,
  verifyEmail,
  newVerificationFor,
} from "../src/backend/store.js";

// The customer-site backend (§14). These cover the security-critical guarantees:
// password verification, session round-trip, TENANT ISOLATION (one site can
// never touch another's users/tokens/records), and owner-scoped records.

const rand = () => Math.random().toString(36).slice(2, 10);

test("register → login → session → logout round-trip", async () => {
  const site = `t-${rand()}`;
  const email = `a${rand()}@ex.com`;
  const u = await registerUser(site, email, "password123", "Ada");
  assert.ok(u, "register returns a user");
  assert.equal(u.email, email);

  // duplicate email on the SAME site is rejected
  assert.equal(await registerUser(site, email, "password123", null), null);
  // wrong password is rejected
  assert.equal(await authenticateUser(site, email, "nope-wrong"), null);
  // correct password authenticates
  const ok = await authenticateUser(site, email, "password123");
  assert.ok(ok);

  const token = await createSession(site, ok.id);
  assert.equal((await userForToken(site, token))?.id, ok.id);
  await destroySession(token);
  assert.equal(await userForToken(site, token), null, "logout invalidates the token");
});

test("tenant isolation: same email independent per site; tokens don't cross sites", async () => {
  const email = `x${rand()}@ex.com`;
  const s1 = `s1-${rand()}`;
  const s2 = `s2-${rand()}`;
  const u1 = await registerUser(s1, email, "password123", null);
  const u2 = await registerUser(s2, email, "password123", null); // same email, other site → OK
  assert.ok(u1 && u2);
  assert.notEqual(u1.id, u2.id, "different sites get separate accounts");

  const t1 = await createSession(s1, u1.id);
  assert.ok(await userForToken(s1, t1), "token resolves on its own site");
  assert.equal(await userForToken(s2, t1), null, "token from site 1 must NOT resolve on site 2");
});

test("records: owner-scoped private vs shared; delete only your own", async () => {
  const site = `rec-${rand()}`;
  const u = await registerUser(site, `r${rand()}@ex.com`, "password123", null);
  assert.ok(u);
  const priv = await createRecord(site, "orders", u.id, { total: 10 });
  const shared = await createRecord(site, "orders", null, { total: 99 });

  const mine = await listRecords(site, "orders", u.id);
  assert.equal(mine.length, 1, "a user lists only their own records");
  assert.equal(mine[0]!.id, priv.id);

  assert.equal(await deleteRecord(site, shared.id, u.id), false, "can't delete a record you don't own");
  assert.equal(await deleteRecord(site, priv.id, u.id), true);
});

test("password reset: token resets the password once, then is dead; sessions cleared", async () => {
  const site = `pr-${rand()}`;
  const email = `p${rand()}@ex.com`;
  const u = await registerUser(site, email, "oldpassword1", null);
  assert.ok(u);
  const oldSession = await createSession(site, u.id);

  const reset = await createPasswordReset(site, email);
  assert.ok(reset?.token, "reset token issued for a real user");
  // unknown email → null (caller responds identically to avoid enumeration)
  assert.equal(await createPasswordReset(site, `nobody${rand()}@ex.com`), null);

  assert.equal(await resetPassword(site, reset!.token, "brandnewpass9"), true);
  // old password no longer works; new one does
  assert.equal(await authenticateUser(site, email, "oldpassword1"), null);
  assert.ok(await authenticateUser(site, email, "brandnewpass9"));
  // reset consumes existing sessions, and the token can't be reused
  assert.equal(await userForToken(site, oldSession), null, "reset logs out old sessions");
  assert.equal(await resetPassword(site, reset!.token, "another12345"), false, "token is single-use");
});

test("records: update is owner-scoped; listSiteUsers returns the site's users", async () => {
  const site = `up-${rand()}`;
  const a = await registerUser(site, `a${rand()}@ex.com`, "password123", null);
  const b = await registerUser(site, `b${rand()}@ex.com`, "password123", null);
  assert.ok(a && b);
  const rec = await createRecord(site, "notes", a.id, { text: "hi" });
  // b cannot update a's record
  assert.equal(await updateRecord(site, rec.id, b.id, { text: "hacked" }), null);
  const updated = await updateRecord(site, rec.id, a.id, { text: "edited" });
  assert.equal((updated?.data as { text: string }).text, "edited");
  const users = await listSiteUsers(site);
  assert.ok(users.length >= 2);
});

test("wireClonedAuth: tags a login form and normalises field names", () => {
  const html = `<html><body>
    <form action="/login" method="post">
      <input type="text" placeholder="Email address">
      <input type="password" placeholder="Password">
      <button>Sign in</button>
    </form></body></html>`;
  const r = wireClonedAuth(html);
  assert.equal(r.hasAuth, true);
  assert.match(r.html, /data-zurum="login"/);
  assert.match(r.html, /name="email"/);
  assert.match(r.html, /name="password"/);
  assert.match(r.html, /data-zurum-message/);
  assert.doesNotMatch(r.html, /action="\/login"/, "original action is neutralised");
});

test("wireClonedAuth: detects a register form; leaves non-auth pages alone", () => {
  const reg = wireClonedAuth(
    `<form><input type="email" name="email"><input type="password"><input type="password" placeholder="Confirm password"><button>Create account</button></form>`,
  );
  assert.match(reg.html, /data-zurum="register"/);
  const plain = wireClonedAuth(`<html><body><form><input type="search"><button>Go</button></form></body></html>`);
  assert.equal(plain.hasAuth, false);
  assert.equal(plain.html.includes("data-zurum"), false);
});

test("uploads: a real PNG is stored + served; a non-image is rejected", async () => {
  const site = `up-${rand()}`;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
    Buffer.from("payloadpayloadpayload"),
  ]);
  const stored = await saveUpload(site, null, png);
  assert.ok(stored, "PNG accepted");
  assert.equal(stored.mime, "image/png");
  const got = await getUpload(site, stored.id);
  assert.ok(got);
  assert.equal(got.mime, "image/png");
  assert.ok(got.bytes.equals(png), "served bytes match stored");
  // a script/html blob (not an image by magic bytes) is refused
  assert.equal(await saveUpload(site, null, Buffer.from("<script>alert(1)</script>")), null);
  // empty is refused
  assert.equal(await saveUpload(site, null, Buffer.alloc(0)), null);
});

test("email verification: token verifies once; re-send only for unverified", async () => {
  const site = `ev-${rand()}`;
  const email = `v${rand()}@ex.com`;
  const u = await registerUser(site, email, "password123", null);
  assert.ok(u);
  assert.equal(u.emailVerified, false, "new users start unverified");

  const token = await createEmailVerification(site, u.id);
  assert.equal(await verifyEmail(site, "bad-token"), false);
  assert.equal(await verifyEmail(site, token), true);
  assert.equal(await verifyEmail(site, token), false, "token is single-use");
  // authenticate now reflects verified
  const after = await authenticateUser(site, email, "password123");
  assert.equal(after?.emailVerified, true);
  // a verified user can't get a new verification link
  assert.equal(await newVerificationFor(site, email), null);
});

test("backend gate: unknown site invisible; enable turns it on with its origins", async () => {
  const site = `cfg-${rand()}`;
  assert.equal(await getSiteBackend(site), null, "an unknown/undeployed site has no backend");
  await enableSiteBackend(site, ["https://shop.example", "https://shop.example/login"]);
  const cfg = await getSiteBackend(site);
  assert.ok(cfg?.enabled);
  assert.ok(cfg.allowedOrigins.includes("https://shop.example"), "origin is normalised + allowed");
});
