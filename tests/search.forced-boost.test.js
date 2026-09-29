const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const { getForcedBoostCandidates } = require("../src/services/search/search.service");

// =========================================================
// DB-backed only. getForcedBoostCandidates() never touches
// GLM/Qdrant and does not even take a query — it is keyed
// purely on {shop, goal} — so this suite stays fast and fully
// deterministic regardless of Ollama/Qdrant reachability.
//
// This is the actual guarantee added by Fix #2: a boosted
// product with zero lexical/semantic resemblance to the
// customer's query still becomes a candidate GLM can see,
// because retrieval never has to "find" it in the first place.
// GLM's own relevance judgment (ai.service.js) is untouched and
// is exercised separately in the live pipeline, not re-verified
// here — see the summary notes for why an end-to-end live-GLM
// test was deliberately left out of this automated suite.
//
// Uses its own isolated shop domain and cleans up everything it
// inserts.
// =========================================================

const TEST_SHOP = "test-shop-forced-boost.myshopify.com";
const OTHER_SHOP = "test-shop-forced-boost-other.myshopify.com";

const makeProduct = (sku, overrides) => ({
  shop: TEST_SHOP,
  sku,
  matchKey: sku,
  shopifyProductId: `gid://shopify/Product/boost-${sku}`,
  shopifyVariantId: `gid://shopify/ProductVariant/boost-${sku}`,
  title: `Product ${sku}`,
  availableForSale: true,
  inventoryQuantity: 10,
  ...overrides
});

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  await Product.deleteMany({ shop: { $in: [TEST_SHOP, OTHER_SHOP] } });

  await Product.create([
    makeProduct("BOOST-001"),
    makeProduct("BOOST-002"),
    makeProduct("BOOST-003"),
    makeProduct("BOOST-004"),
    makeProduct("BOOST-005"),
    makeProduct("BOOST-006"),
    makeProduct("BOOST-007"), // 7th SKU — used to prove the 6-item cap
    makeProduct("BOOST-UNAVAILABLE", { availableForSale: false }),
    makeProduct("", {
      sku: "",
      matchKey: "variant:boost-skuless-1",
      title: "SKU-less Boost Product",
      shopifyProductId: "gid://shopify/Product/boost-skuless-1",
      shopifyVariantId: "gid://shopify/ProductVariant/boost-skuless-1"
    }),
    {
      ...makeProduct("BOOST-001"),
      shop: OTHER_SHOP,
      shopifyProductId: "gid://shopify/Product/boost-other-shop",
      shopifyVariantId: "gid://shopify/ProductVariant/boost-other-shop"
    }
  ]);
});

after(async () => {
  await Product.deleteMany({ shop: { $in: [TEST_SHOP, OTHER_SHOP] } });
  await mongoose.disconnect();
});

test("returns [] when there is no active goal", async () => {
  const result = await getForcedBoostCandidates({ shop: TEST_SHOP, goal: null });
  assert.deepEqual(result, []);
});

test("returns [] for an exclude goal — forced-boost injection must not affect exclude", async () => {
  const goal = { ruleType: "exclude", skus: ["BOOST-001"] };
  const result = await getForcedBoostCandidates({ shop: TEST_SHOP, goal });
  assert.deepEqual(result, []);
});

test("returns [] for a demote goal — forced-boost injection must not affect demote", async () => {
  const goal = { ruleType: "demote", skus: ["BOOST-001"] };
  const result = await getForcedBoostCandidates({ shop: TEST_SHOP, goal });
  assert.deepEqual(result, []);
});

test("returns [] for a boost goal with no skus configured", async () => {
  const goal = { ruleType: "boost", skus: [] };
  const result = await getForcedBoostCandidates({ shop: TEST_SHOP, goal });
  assert.deepEqual(result, []);
});

test("returns the available boosted product regardless of query relevance (it isn't even a parameter)", async () => {
  const goal = { ruleType: "boost", skus: ["BOOST-001"] };
  const result = await getForcedBoostCandidates({ shop: TEST_SHOP, goal });
  assert.equal(result.length, 1);
  assert.equal(result[0].sku, "BOOST-001");
});

test("excludes an out-of-stock boosted SKU — availability filtering is preserved", async () => {
  const goal = { ruleType: "boost", skus: ["BOOST-UNAVAILABLE"] };
  const result = await getForcedBoostCandidates({ shop: TEST_SHOP, goal });
  assert.deepEqual(result, []);
});

test("caps injected forced-boost candidates at 6, even when the goal lists more", async () => {
  const goal = {
    ruleType: "boost",
    skus: [
      "BOOST-001", "BOOST-002", "BOOST-003",
      "BOOST-004", "BOOST-005", "BOOST-006", "BOOST-007"
    ]
  };
  const result = await getForcedBoostCandidates({ shop: TEST_SHOP, goal });
  assert.equal(result.length, 6);
  assert.ok(!result.some(product => product.sku === "BOOST-007"));
});

test("boosts a SKU-less product correctly, matched by its Shopify-Variant-ID matchKey", async () => {
  const goal = { ruleType: "boost", skus: ["variant:boost-skuless-1"] };
  const result = await getForcedBoostCandidates({ shop: TEST_SHOP, goal });
  assert.equal(result.length, 1);
  assert.equal(result[0].matchKey, "variant:boost-skuless-1");
  assert.equal(result[0].sku, "");
});

test("is shop-scoped — a same-SKU product from a different shop never leaks in", async () => {
  const goal = { ruleType: "boost", skus: ["BOOST-001"] };
  const result = await getForcedBoostCandidates({ shop: OTHER_SHOP, goal });
  assert.equal(result.length, 1);
  assert.equal(result[0].shop, OTHER_SHOP);
});
