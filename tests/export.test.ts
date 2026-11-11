import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/db/index.js";
import { saveSite } from "../src/sites/store.js";
import { siteDataCsvs, buildSiteExport } from "../src/panel/data-export.js";

const rand = () => Math.random().toString(36).slice(2, 8);

test("export: gathers only non-empty business data as CSV, scoped to the site", async () => {
  const site = `ex-${rand()}`;
  const other = `ex-${rand()}`;
  const db = await getDb();
  // This site's data.
  await db.query(
    `INSERT INTO form_submissions (site_id, form_name, data) VALUES ($1, 'contact', $2::jsonb)`,
    [site, JSON.stringify({ name: "Ada", message: "hi, has a comma, and \"quotes\"" })],
  );
  await db.query(
    `INSERT INTO site_users (site_id, email, password_hash, name) VALUES ($1, 'buyer@x.com', 'secrethash', 'Buyer')`,
    [site],
  );
  // Another site's data — must NOT leak into this export.
  await db.query(
    `INSERT INTO form_submissions (site_id, form_name, data) VALUES ($1, 'contact', '{"name":"Other"}'::jsonb)`,
    [other],
  );

  const csvs = await siteDataCsvs(site);
  assert.ok(csvs.has("data/form-submissions.csv"), "submissions csv present");
  assert.ok(csvs.has("data/customers.csv"), "customers csv present");
  assert.ok(!csvs.has("data/orders.csv"), "no orders → no orders csv");

  const subs = csvs.get("data/form-submissions.csv")!;
  assert.ok(subs.includes("Ada"), "includes this site's row");
  assert.ok(!subs.includes("Other"), "does NOT include another site's row");
  // CSV quoting of a value containing commas + quotes.
  assert.ok(subs.includes('"hi, has a comma, and ""quotes"""'), "quotes/commas escaped");

  // Password hashes are never exported.
  const custs = csvs.get("data/customers.csv")!;
  assert.ok(!custs.includes("secrethash"), "password hash excluded");
});

test("export: full bundle is a valid zip with site code + data + README", async () => {
  const site = `ex-${rand()}`;
  await saveSite(site, "<!doctype html><title>Home</title><h1>Hi</h1>");
  const db = await getDb();
  await db.query(
    `INSERT INTO form_submissions (site_id, form_name, data) VALUES ($1, 'contact', '{"name":"Zoe"}'::jsonb)`,
    [site],
  );

  const zip = await buildSiteExport(site);
  // Local file header magic + End Of Central Directory record → a real zip.
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "starts with local file header");
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, "ends with EOCD");
  const text = zip.toString("latin1");
  assert.ok(text.includes("site/index.html"), "contains site code path");
  assert.ok(text.includes("data/form-submissions.csv"), "contains data path");
  assert.ok(text.includes("README.txt"), "contains README");
});
