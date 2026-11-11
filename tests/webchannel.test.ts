import { test } from "node:test";
import assert from "node:assert/strict";
import { WebChannel } from "../src/channels/web.js";

test("WebChannel: delivers inbound, buffers replies, polls by cursor, isolates chats", async () => {
  const w = new WebChannel();
  let got = "";
  await w.start(async (m) => {
    got = `${m.channel}:${m.chatId}:${m.text}`;
  });

  await w.receive("u1", "build me a shop");
  assert.equal(got, "web:u1:build me a shop");

  await w.send("u1", "On it! 🛠️");
  await w.sendActions("u1", "Approve?", [{ id: "approve", label: "Publish" }]);

  // The user's own message is buffered too (survives a reload), so 3 total.
  const first = w.poll("u1", 0);
  assert.equal(first.messages.length, 3);
  assert.equal(first.cursor, 3);
  assert.equal(first.messages[0]!.role, "user");
  assert.equal(first.messages[0]!.text, "build me a shop");
  assert.equal(first.messages[1]!.text, "On it! 🛠️");
  assert.equal(first.messages[2]!.actions?.[0]!.id, "approve");

  // Polling past the cursor returns nothing new.
  assert.equal(w.poll("u1", first.cursor).messages.length, 0);
  // A different chat is isolated.
  assert.equal(w.poll("u2", 0).messages.length, 0);
});
