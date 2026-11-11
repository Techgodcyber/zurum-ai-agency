import { test } from "node:test";
import assert from "node:assert/strict";
import { interactive } from "../src/channels/whatsapp.js";

// WhatsApp reply-button titles are capped at 20 chars and list-row titles at 24;
// our action labels are longer (e.g. "✅ It's my site — rebuild it"), so the
// builder MUST truncate or Meta rejects the whole message.

test("WhatsApp: ≤3 actions render as reply buttons, titles ≤20 chars", () => {
  const p = interactive("Whose site is this?", [
    { id: "url_mine", label: "✅ It's my site — rebuild it exactly" },
    { id: "url_inspire", label: "💡 Just use it as inspiration for a new one" },
  ]) as any;
  assert.equal(p.type, "button");
  const buttons = p.action.buttons;
  assert.equal(buttons.length, 2);
  for (const b of buttons) {
    assert.equal(b.type, "reply");
    assert.ok(b.reply.title.length <= 20, `title too long: ${b.reply.title}`);
    assert.ok(b.reply.id.length > 0);
  }
  // The action id must survive intact so a tap maps back to app logic.
  assert.equal(buttons[0].reply.id, "url_mine");
});

test("WhatsApp: 4–10 actions render as a list, titles ≤24 chars", () => {
  const actions = Array.from({ length: 5 }, (_, i) => ({
    id: `amt_${i}`,
    label: `Top up option number ${i} — pay a nice round amount`,
  }));
  const p = interactive("Choose an amount", actions) as any;
  assert.equal(p.type, "list");
  const rows = p.action.sections[0].rows;
  assert.equal(rows.length, 5);
  for (const r of rows) assert.ok(r.title.length <= 24, `row title too long: ${r.title}`);
  assert.equal(rows[2].id, "amt_2");
});
