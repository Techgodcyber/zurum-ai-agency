import { test } from "node:test";
import assert from "node:assert/strict";
import { recordEvent, siteAnalytics, trafficForSites } from "../src/growth/analytics.js";

const rand = () => Math.random().toString(36).slice(2, 8);

test("analytics: records pageviews, aggregates views/visitors/top pages", async () => {
  const site = `an-${rand()}`;
  await recordEvent(site, "v1", "/", "google.com");
  await recordEvent(site, "v1", "/about", null);
  await recordEvent(site, "v2", "/", null);

  const a = await siteAnalytics(site, 7);
  assert.equal(a.views, 3, "3 pageviews");
  assert.equal(a.visitors, 2, "2 distinct visitors");
  assert.equal(a.topPages.find((p) => p.path === "/")?.views, 2);
  assert.equal(a.topRefs.find((r) => r.ref === "google.com")?.views, 1);

  const t = await trafficForSites([site], 7);
  assert.equal(t.views, 3);
  assert.equal(t.visitors, 2);
  assert.equal((await trafficForSites([], 7)).views, 0);
});
