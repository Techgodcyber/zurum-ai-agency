import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerUser,
  authenticateUser,
  createSession,
  userForToken,
  createRecord,
  listRecords,
  updateRecord,
  deleteRecord,
} from "../src/backend/store.js";

/**
 * Cross-tenant isolation guard (ARCHITECTURE §14.4 L4). Two sites share ONE
 * database; isolation is the site_id filter on every query. This test proves a
 * site can NEVER reach another site's users, sessions, or records — if anyone
 * ever drops a site_id filter, this goes red.
 */

const rand = () => Math.random().toString(36).slice(2, 8);

test("tenant isolation: Site A cannot touch Site B's users, sessions, or records", async () => {
  const A = `iso-a-${rand()}`;
  const B = `iso-b-${rand()}`;

  // A user on each site — SAME email on purpose, to prove they're independent.
  const email = `owner-${rand()}@example.com`;
  const ua = await registerUser(A, email, "passwordA123", "Ada on A");
  const ub = await registerUser(B, email, "passwordB456", "Ben on B");
  assert.ok(ua && ub, "both registered");
  assert.notEqual(ua!.id, ub!.id, "same email on two sites = two distinct users");

  // 1) A session minted for A must NOT resolve on B.
  const tokenA = await createSession(A, ua!.id);
  assert.ok(await userForToken(A, tokenA), "token works on its own site");
  assert.equal(await userForToken(B, tokenA), null, "A's token is worthless on B");

  // 2) A's password must NOT authenticate against B (and vice-versa).
  assert.ok(await authenticateUser(A, email, "passwordA123"), "A logs in on A");
  assert.equal(await authenticateUser(B, email, "passwordA123"), null, "A's password fails on B");

  // 3) A record created under A must be invisible + immutable + undeletable from B.
  const rec = await createRecord(A, "orders", ua!.id, { total: 5000 });
  assert.equal((await listRecords(A, "orders", ua!.id)).length, 1, "A sees its own record");
  assert.equal((await listRecords(B, "orders", ub!.id)).length, 0, "B sees none of A's records");
  // Even knowing the exact record id, B cannot update or delete it.
  assert.equal(await updateRecord(B, rec.id, ub!.id, { total: 0 }), null, "B cannot update A's record by id");
  assert.equal(await deleteRecord(B, rec.id, ub!.id), false, "B cannot delete A's record by id");
  // A's record is untouched.
  const still = await listRecords(A, "orders", ua!.id);
  assert.equal(still[0]?.data.total, 5000, "A's record is intact");
});
