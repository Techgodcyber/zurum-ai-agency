import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { isPanelRequest, isSignupsQuestion } from "../src/app.js";
import { zipFiles } from "../src/panel/archive.js";
import { createPanelToken, userForPanelToken } from "../src/panel/tokens.js";
import { getDb } from "../src/db/index.js";

test("isPanelRequest: recognises MY-account intent, never hijacks a build", () => {
  for (const s of [
    "my dashboard",
    "open my dashboard",
    "i want my dashboard",
    "can I download my code",
    "export my source files",
    "manage my account",
    "give me my control panel",
    "my account",
  ]) {
    assert.equal(isPanelRequest(s), true, `should match: ${s}`);
  }
  // BUILD/EDIT instructions must NEVER be treated as a panel request (the bug).
  for (const s of [
    "build me a shop",
    "build me dashboard, signup page, login page and admin page on the bank you just created",
    "build an online banking",
    "add a dashboard to my site",
    "make me an admin dashboard",
    "create a login page",
    "i need an admin panel page",
    "send me my link",
    "make the logo bigger",
    "how much for a domain",
  ]) {
    assert.equal(isPanelRequest(s), false, `should NOT match (it's a build): ${s}`);
  }
});

test("isSignupsQuestion: recognises the owner's members/signups question", () => {
  for (const s of [
    "how many signed up",
    "who registered on my site",
    "my users",
    "how many signups do i have",
    "site members",
    "my subscribers",
  ]) {
    assert.equal(isSignupsQuestion(s), true, `should match: ${s}`);
  }
  for (const s of ["how many websites can i build", "build me a site", "my balance", "make the logo bigger"]) {
    assert.equal(isSignupsQuestion(s), false, `should NOT match: ${s}`);
  }
});

test("zipFiles: valid zip container that round-trips the first entry", () => {
  const files = new Map([
    ["/index.html", "<h1>Home</h1>"],
    ["/login/index.html", "<form>login</form>"],
  ]);
  const zip = zipFiles(files);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "starts with a local file header");
  const eocd = zip.subarray(zip.length - 22);
  assert.equal(eocd.readUInt32LE(0), 0x06054b50, "ends with the end-of-central-directory record");
  assert.equal(eocd.readUInt16LE(10), 2, "records both files");
  // Inflate the first stored entry and confirm the content survives intact.
  const nameLen = zip.readUInt16LE(26);
  const compSize = zip.readUInt32LE(18);
  const comp = zip.subarray(30 + nameLen, 30 + nameLen + compSize);
  assert.equal(inflateRawSync(comp).toString("utf8"), "<h1>Home</h1>");
});

test("panel token: round-trips to its user, rejects bad/expired tokens", async () => {
  const db = await getDb();
  const u = await db.query<{ id: string }>(`INSERT INTO users (name) VALUES ('panel-test') RETURNING id`);
  const userId = u[0]!.id;
  const token = await createPanelToken(userId);
  assert.equal(await userForPanelToken(token), userId);
  assert.equal(await userForPanelToken("not-a-real-token"), null);
  assert.equal(await userForPanelToken(null), null);
});

test("normalizePhone: digits + country code; NG local → 234", async () => {
  const { normalizePhone } = await import("../src/panel/otp.js");
  assert.equal(normalizePhone("+234 916 946 4811"), "2349169464811");
  assert.equal(normalizePhone("08012345678"), "2348012345678"); // NG local
  assert.equal(normalizePhone("00234 8012345678"), "2348012345678"); // 00 prefix
  assert.equal(normalizePhone("abc"), null);
  assert.equal(normalizePhone("12"), null); // too short
});

test("login OTP: create → verify once; wrong code fails, single-use", async () => {
  const { createLoginOtp, verifyLoginOtp } = await import("../src/panel/otp.js");
  const phone = "23480" + Math.floor(Math.random() * 1e8);
  const code = await createLoginOtp(phone);
  assert.match(code, /^\d{6}$/);
  assert.equal(await verifyLoginOtp(phone, "000000".slice(0, 6) === code ? "111111" : "000000"), false);
  assert.equal(await verifyLoginOtp(phone, code), true);
  assert.equal(await verifyLoginOtp(phone, code), false, "single-use");
});

test("merchant commands: flutterwave key, connect, add-product, sales parsers", async () => {
  const { isFlutterwaveKey, isConnectPayment, parseAddProduct, isSalesQuestion } = await import("../src/app.js");
  assert.equal(isFlutterwaveKey("FLWSECK-abc123"), true);
  assert.equal(isFlutterwaveKey("FLWSECK_TEST-xyz"), true);
  assert.equal(isFlutterwaveKey("hello there"), false);
  assert.equal(isConnectPayment("connect payment"), true);
  assert.equal(isConnectPayment("set up payments"), true);
  assert.equal(isConnectPayment("i want to take payments"), true);
  assert.equal(isConnectPayment("build me a site"), false);
  assert.deepEqual(parseAddProduct("add product Sneakers 25000"), { name: "Sneakers", price: 25000 });
  assert.deepEqual(parseAddProduct("add product Red Shoes for 15,000"), { name: "Red Shoes", price: 15000 });
  assert.deepEqual(parseAddProduct("add product Cap ₦2000"), { name: "Cap", price: 2000 });
  assert.equal(parseAddProduct("add product NoPrice"), null);
  assert.equal(parseAddProduct("add a product section to my site"), null);
  assert.equal(parseAddProduct("make the header blue"), null);
  assert.equal(isSalesQuestion("my sales"), true);
  assert.equal(isSalesQuestion("how much have i made"), true);
  assert.equal(isSalesQuestion("build a shop"), false);
});

test("growth report: detector + message formatting with trends", async () => {
  const { isReportRequest } = await import("../src/app.js");
  const { formatReport } = await import("../src/growth/report.js");
  assert.equal(isReportRequest("my report"), true);
  assert.equal(isReportRequest("how's my site doing"), true);
  assert.equal(isReportRequest("how am i doing"), true);
  assert.equal(isReportRequest("weekly report"), true);
  assert.equal(isReportRequest("build me a site"), false);
  const msg = formatReport({
    now: { views: 100, visitors: 40, signups: 5, orders: 2, revenue: 50000, currency: "NGN", enquiries: 3 },
    prev: { views: 50, visitors: 20, signups: 5, orders: 0, revenue: 0, currency: "NGN", enquiries: 0 },
    tips: ["Share your link"],
  });
  assert.match(msg, /Visitors: \*40\*/);
  assert.match(msg, /▲100%/);
  assert.match(msg, /💡 Share your link/);
});

test("content tools: detector matches marketing asks, not builds", async () => {
  const { isContentRequest } = await import("../src/app.js");
  for (const s of [
    "write me a blog post about coffee",
    "give me instagram captions for my bakery",
    "write a product description for my sneakers",
    "generate ad copy for my shop",
    "draft a newsletter",
  ]) assert.equal(isContentRequest(s), true, `should match: ${s}`);
  for (const s of ["build me a website", "make me a logo", "add a login page", "how's my site doing"]) {
    assert.equal(isContentRequest(s), false, `should NOT match: ${s}`);
  }
});

test("business email: detector + parse address/domain", async () => {
  const { isBusinessEmailRequest, parseEmailRequest } = await import("../src/app.js");
  for (const s of ["create support@waterfactoryweb.com","set up my business email","i want a professional email","get me a mailbox"])
    assert.equal(isBusinessEmailRequest(s), true, `match: ${s}`);
  for (const s of ["write me a marketing email","build me a site","how's my site doing"])
    assert.equal(isBusinessEmailRequest(s), false, `no match: ${s}`);
  assert.deepEqual(parseEmailRequest("create support@waterfactoryweb.com"), { localPart: "support", domain: "waterfactoryweb.com" });
  assert.deepEqual(parseEmailRequest("business email for waterfactoryweb.com"), { localPart: "support", domain: "waterfactoryweb.com" });
  assert.equal(parseEmailRequest("set up my business email"), null);
});
