import { test } from "node:test";
import assert from "node:assert/strict";
import { isTopupRequest, isBalanceRequest, parseTransfer } from "../src/billing/metering.js";
import { creditsForUsd, topupPackages, packagesLine } from "../src/billing/payments.js";

test("isTopupRequest: recognises buying/adding credits, ignores chatter", () => {
  assert.equal(isTopupRequest("i want to top up"), true);
  assert.equal(isTopupRequest("buy more credit"), true);
  assert.equal(isTopupRequest("I need more edits"), true);
  assert.equal(isTopupRequest("make the logo bigger"), false);
});

test("isBalanceRequest: recognises balance questions", () => {
  assert.equal(isBalanceRequest("what is my balance"), true);
  assert.equal(isBalanceRequest("how many credits do i have"), true);
  assert.equal(isBalanceRequest("credits left?"), true);
  // Real phrasings that used to slip through (from the live transcript).
  assert.equal(isBalanceRequest("do i still have credits?"), true);
  assert.equal(isBalanceRequest("do i have credit"), true);
  assert.equal(isBalanceRequest("build me a shop"), false);
});

test("isTopupRequest: matches 'buy credits' (plural) and friends", () => {
  assert.equal(isTopupRequest("buy credits"), true); // was failing (trailing \b + no plural)
  assert.equal(isTopupRequest("buy credit"), true);
  assert.equal(isTopupRequest("i want to top up"), true);
  assert.equal(isTopupRequest("add more credits"), true);
  assert.equal(isTopupRequest("get credits"), true);
  assert.equal(isTopupRequest("make the logo bigger"), false);
});

test("isTopupRequest: catches money/fund/account phrasings (from transcript)", () => {
  assert.equal(isTopupRequest("how do i add money to my account"), true);
  assert.equal(isTopupRequest("add money to my account"), true);
  assert.equal(isTopupRequest("i want to buy more credit"), true);
  assert.equal(isTopupRequest("fund my account"), true);
  // Must NOT hijack normal chat or site edits.
  assert.equal(isTopupRequest("how are you doing?"), false);
  assert.equal(isTopupRequest("add a contact section"), false);
  assert.equal(isTopupRequest("add my logo"), false);
});

test("parseTransfer: reads amount + recipient, rejects non-transfers", () => {
  assert.deepEqual(parseTransfer("send 20 credits to 2348012345678"), {
    amount: 20,
    recipient: "2348012345678",
  });
  assert.deepEqual(parseTransfer("transfer 5 credits to telegram:12345"), {
    amount: 5,
    recipient: "telegram:12345",
  });
  assert.deepEqual(parseTransfer("gift 1 credit to +2348011112222"), {
    amount: 1,
    recipient: "+2348011112222",
  });
  assert.equal(parseTransfer("send me the link"), null);
  assert.equal(parseTransfer("build me a website"), null);
});

test("creditsForUsd + packages: convert at the configured rate (default 10/$)", () => {
  // Defaults: CREDITS_PER_USD=10, MIN_TOPUP_USD=5.
  assert.equal(creditsForUsd(5), 50);
  assert.equal(creditsForUsd(10), 100);
  const pkgs = topupPackages();
  assert.equal(pkgs.length, 3);
  assert.deepEqual(pkgs[0], { usd: 5, credits: 50 }); // min
  assert.deepEqual(pkgs[2], { usd: 20, credits: 200 }); // 4×
  assert.match(packagesLine(), /\$5 → 50 credits/);
});
