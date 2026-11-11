import { test } from "node:test";
import assert from "node:assert/strict";

// Encryption needs a MASTER_KEY. Set it BEFORE anything that loads env.ts, then
// import the modules dynamically so they pick it up (self-contained test).
process.env.MASTER_KEY ||= "test0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab";

const rand = () => Math.random().toString(36).slice(2, 8);

test("crypto-box: round-trips a secret, rejects garbage", async () => {
  const { encryptSecret, decryptSecret } = await import("../src/lib/crypto-box.js");
  const enc = encryptSecret("FLWSECK_TEST-123");
  assert.ok(enc && enc.startsWith("v1:"));
  assert.equal(decryptSecret(enc), "FLWSECK_TEST-123");
  assert.equal(decryptSecret("garbage"), null);
  assert.equal(decryptSecret(null), null);
});

test("store: encrypted payment config, products, checkout guards", async () => {
  const { setPaymentConfig, getStoreInfo, addProduct, listProducts, deleteProduct, checkout, orderStats } =
    await import("../src/backend/commerce.js");
  const site = `shop-${rand()}`;
  assert.equal((await checkout(site, [{ productId: "x", qty: 1 }], {})).status, "not_configured");

  assert.equal(await setPaymentConfig(site, "FLWSECK_TEST-abc", "NGN"), true);
  const info = await getStoreInfo(site);
  assert.equal(info.live, true);
  assert.equal(info.currency, "NGN");

  const p = await addProduct(site, "Sneakers", 25000, "NGN");
  assert.equal(p.price, 25000);
  assert.equal((await listProducts(site)).length, 1);

  assert.equal((await checkout(site, [], {})).status, "empty");
  assert.equal((await checkout(site, [{ productId: "nope", qty: 1 }], {})).status, "invalid");

  assert.equal(await deleteProduct(site, p.id), true);
  assert.equal((await listProducts(site)).length, 0);
  assert.equal((await orderStats(site)).paid, 0);
});
