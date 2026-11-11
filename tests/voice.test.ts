import { test } from "node:test";
import assert from "node:assert/strict";
import { languageSample, looksMeta } from "../src/agents/voice.js";

// The "meta leak": phrase() must never treat a tapped-button id as the
// customer's language, and must never send the model's meta/clarification text.

test("languageSample: strips button ids / system tokens, keeps real messages", () => {
  for (const id of ["request_change", "topup_5", "cur_NGN_5", "domain_buy", "paid_zpub-abc", "url_mine"]) {
    assert.equal(languageSample(id), "", `should drop token: ${id}`);
  }
  assert.equal(languageSample("Abeg make the background blue"), "Abeg make the background blue");
  assert.equal(languageSample("  Bonjour, je veux un site  "), "Bonjour, je veux un site");
  assert.equal(languageSample(""), "");
});

test("looksMeta: catches the exact leak + common meta, passes real replies", () => {
  const leak =
    "I need the customer's last message to match the language/dialect. The reference \"request_change\" appears to be a placeholder rather than an actual customer message.";
  assert.equal(looksMeta(leak), true);
  assert.equal(looksMeta("Could you please provide the actual message?"), true);
  assert.equal(looksMeta("As an AI, I can't do that."), true);
  // genuine customer-facing replies must pass through
  assert.equal(looksMeta("Sure! Just tell me what to change 😊"), false);
  assert.equal(looksMeta("Your site is live! 🎉 Want me to add a booking section?"), false);
  assert.equal(looksMeta("No wahala, I go change am now 👍"), false);
});
