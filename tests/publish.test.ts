import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPlan } from "../src/billing/publish.js";

// The plan drives the publish price, so classification must be reliable: real
// backend/app requests → the pricier dynamic tier; brochure sites → static.

test("plan: dashboards / portals / apps with accounts → dynamic", () => {
  for (const s of [
    "Build me an admin dashboard for my shop",
    "a customer portal with login",
    "an online store with user accounts and sign up",
    "a CRM web app for my team",
    "members area with authentication",
  ]) {
    assert.equal(detectPlan(s), "dynamic", s);
  }
});

test("plan: brochure / static sites → static", () => {
  for (const s of [
    "a bakery website with a menu and gallery",
    "portfolio for a photographer",
    "landing page for my restaurant",
    "a barbershop site with a contact form and map",
  ]) {
    assert.equal(detectPlan(s), "static", s);
  }
});
