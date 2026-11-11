import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseIdentities,
  effectiveLimit,
  parseCommand,
  splitIdentity,
} from "../src/billing/quota.js";

test("effectiveLimit: override > default, -1 = unlimited, 0 default = off", () => {
  assert.equal(effectiveLimit(null, 3), 3); // no override → global default
  assert.equal(effectiveLimit(10, 3), 10); // per-user override wins
  assert.equal(effectiveLimit(-1, 3), Infinity); // explicit unlimited
  assert.equal(effectiveLimit(null, 0), Infinity); // global 0 → enforcement off
  assert.equal(effectiveLimit(0, 3), 0); // a real cap of zero
});

test("parseIdentities: splits, trims, lowercases, drops blanks", () => {
  const s = parseIdentities("telegram:1, Telegram:2 ,,whatsapp:3");
  assert.ok(s.has("telegram:1"));
  assert.ok(s.has("telegram:2"));
  assert.ok(s.has("whatsapp:3"));
  assert.equal(s.size, 3);
  assert.equal(parseIdentities("").size, 0);
  assert.equal(parseIdentities(null).size, 0);
});

test("splitIdentity: parses channel:externalId, rejects malformed", () => {
  assert.deepEqual(splitIdentity("telegram:12345"), { channel: "telegram", externalId: "12345" });
  assert.equal(splitIdentity("nope"), null);
  assert.equal(splitIdentity(":123"), null);
  assert.equal(splitIdentity("telegram:"), null);
});

test("parseCommand: recognises /id, /quota, /limit with valid values", () => {
  assert.deepEqual(parseCommand("/id"), { kind: "id" });
  assert.deepEqual(parseCommand("/quota telegram:1"), { kind: "quota", target: "telegram:1" });
  assert.deepEqual(parseCommand("/limit telegram:1 5"), { kind: "limit", target: "telegram:1", value: 5 });
  assert.deepEqual(parseCommand("/limit telegram:1 unlimited"), {
    kind: "limit",
    target: "telegram:1",
    value: "unlimited",
  });
  assert.deepEqual(parseCommand("/limit telegram:1 default"), {
    kind: "limit",
    target: "telegram:1",
    value: "default",
  });
  // Not commands / invalid.
  assert.equal(parseCommand("hello there"), null);
  assert.equal(parseCommand("/limit telegram:1 -3"), null); // negative not allowed
  assert.equal(parseCommand("/limit telegram:1 abc"), null);
});

test("parseCommand: recognises /credits (self) and /grant (admin)", () => {
  assert.deepEqual(parseCommand("/credits"), { kind: "balance" });
  assert.deepEqual(parseCommand("/balance"), { kind: "balance" });
  assert.deepEqual(parseCommand("/grant telegram:1 50"), { kind: "grant", target: "telegram:1", value: 50 });
  assert.equal(parseCommand("/grant telegram:1 abc"), null);
});

test("parseCommand: recognises /config and /set (control center)", () => {
  assert.deepEqual(parseCommand("/config"), { kind: "config" });
  assert.deepEqual(parseCommand("/set free_edit_limit 15"), {
    kind: "set",
    key: "free_edit_limit",
    value: 15,
  });
  assert.deepEqual(parseCommand("/set FREE_EDIT_LIMIT 20"), {
    kind: "set",
    key: "free_edit_limit",
    value: 20,
  });
  assert.equal(parseCommand("/set free_edit_limit"), null); // needs a value
});
