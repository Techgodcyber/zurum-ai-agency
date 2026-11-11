import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDomain,
  domainRequest,
  isDomainFollowup,
  suggestAlternatives,
} from "../src/domains/intake.js";
import { customerPrice, priceLabel } from "../src/domains/pricing.js";
import { parseAvailability, parsePrices, replyCode, buildUrl } from "../src/domains/namesilo.js";
import { apexOf } from "../src/domains/connect.js";

test("extractDomain: finds a real domain, ignores our own hosts", () => {
  assert.equal(extractDomain("i need a domain hopelivegiver.com"), "hopelivegiver.com");
  assert.equal(extractDomain("buy My-Church.ORG for me"), "my-church.org");
  assert.equal(extractDomain("just a plain sentence with no site"), null);
  // Our own preview/hosting URLs are never treated as a wanted domain.
  assert.equal(extractDomain("https://zurum-hope.netlify.app is great"), null);
});

test("domainRequest: triggers on the word 'domain' or buy+domain, not passing mentions", () => {
  assert.deepEqual(domainRequest("i need a domain hopelivegiver.com"), {
    domain: "hopelivegiver.com",
  });
  assert.deepEqual(domainRequest("register mychurch.org"), { domain: "mychurch.org" });
  // "domain" with no name yet → still a request, name unknown.
  assert.deepEqual(domainRequest("can i get a custom domain?"), { domain: null });
  // A passing link mention is NOT a domain purchase request.
  assert.equal(domainRequest("add a link to google.com in the footer"), null);
  // A plain build ask is not a domain request.
  assert.equal(domainRequest("build me a bakery website"), null);
});

test("isDomainFollowup: recognises chasing a previously requested domain", () => {
  assert.equal(isDomainFollowup("where is the domain"), true);
  assert.equal(isDomainFollowup("i mean the one i told you to buy"), true);
  assert.equal(isDomainFollowup("make the header blue"), false);
});

test("customerPrice: adds exactly 20% and rounds to cents", () => {
  assert.equal(customerPrice(10), 12); // 10 * 1.2
  assert.equal(customerPrice(10.99), 13.19); // 13.188 → 13.19
  assert.equal(customerPrice(32), 38.4);
  assert.equal(priceLabel(10.99), "$13.19/year");
});

test("suggestAlternatives: offers close names, never the original", () => {
  const alts = suggestAlternatives("hopelivegiver.com");
  assert.ok(!alts.includes("hopelivegiver.com"));
  assert.ok(alts.includes("hopelivegiver.org"));
  assert.ok(alts.some((a) => a.startsWith("gethopelivegiver")));
  assert.ok(alts.length <= 4);
});

test("apexOf: strips www to the root domain", () => {
  assert.equal(apexOf("www.Hope.com"), "hope.com");
  assert.equal(apexOf("hope.com"), "hope.com");
});

test("apexOf: trims + lowercases and handles a bare www", () => {
  assert.equal(apexOf("  WWW.Shop.CO "), "shop.co");
});

test("namesilo: buildUrl always carries version/type/key and the op", () => {
  const url = buildUrl("checkRegisterAvailability", { domains: "x.com" });
  assert.match(url, /\/checkRegisterAvailability\?/);
  assert.match(url, /version=1/);
  assert.match(url, /type=xml/);
  assert.match(url, /domains=x\.com/);
});

test("namesilo: parseAvailability reads available/taken/invalid + price", () => {
  const xml = `<namesilo><reply><code>300</code><detail>success</detail>
    <available><domain price="11.99" duration="1">good.com</domain></available>
    <unavailable><domain>taken.com</domain></unavailable>
    <invalid><domain>bad_name</domain></invalid>
  </reply></namesilo>`;
  const list = parseAvailability(xml);
  const good = list.find((d) => d.domain === "good.com");
  assert.equal(good?.status, "available");
  assert.equal(good?.cost, 11.99);
  assert.equal(list.find((d) => d.domain === "taken.com")?.status, "taken");
  assert.equal(list.find((d) => d.domain === "bad_name")?.status, "invalid");
});

test("namesilo: parsePrices + replyCode read the documented shape", () => {
  const xml = `<namesilo><reply><code>300</code><detail>success</detail>
    <com><registration>8.99</registration><transfer>8.99</transfer><renew>9.99</renew></com>
    <io><registration>32.00</registration></io>
  </reply></namesilo>`;
  const prices = parsePrices(xml);
  assert.equal(prices["com"], 8.99);
  assert.equal(prices["io"], 32);
  assert.equal(replyCode(xml).code, "300");
});

// Funded-account spend guard (§4.1) — the catastrophic-loss backstop.
test("spend guard: blocks a cost above the daily cap, allows a small one", async () => {
  const { checkDomainSpend } = await import("../src/domains/spend-guard.js");
  const huge = await checkDomainSpend(100000);
  assert.equal(huge.allowed, false, "a $100k domain must be blocked");
  assert.match(huge.reason ?? "", /cap/i);
  const small = await checkDomainSpend(12);
  assert.equal(small.allowed, true, "a normal $12 domain is within caps");
});
