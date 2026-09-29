const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const { findExactSkuMatch, searchProducts } = require("../src/services/search/search.service");

// =========================================================
// DB-backed only. Never touches GLM/Qdrant: findExactSkuMatch()
// is a single Mongo lookup by design (see search.service.js),
// so this suite stays fast and reliable independent of Ollama/
// Qdrant reachability.
//
// Uses its own isolated shop domain and cleans up everything it
// inserts, so it never touches real seeded catalog data.
// =========================================================

const TEST_SHOP = "test-shop-exact-sku.myshopify.com";

const baseProduct = (overrides) => ({
  shop: TEST_SHOP,
  shopifyProductId: "gid://shopify/Product/test",
  shopifyVariantId: "gid://shopify/ProductVariant/test",
  title: "Test Product",
  availableForSale: true,
  inventoryQuantity: 10,
  ...overrides,
  // matchKey defaults to the given sku, same rule the app itself
  // applies (see Product.js) — only override it explicitly when a
  // test needs a SKU-less fixture (matchKey without a real sku).
  matchKey: overrides.matchKey || overrides.sku || ""
});

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  await Product.deleteMany({ shop: TEST_SHOP });

  await Product.create([
    baseProduct({
      sku: "TEST-SKU-001",
      title: "Available Widget",
      shopifyProductId: "gid://shopify/Product/test-1",
      shopifyVariantId: "gid://shopify/ProductVariant/test-1"
    }),
    baseProduct({
      sku: "TEST-SKU-002",
      title: "Unavailable Widget",
      availableForSale: false,
      shopifyProductId: "gid://shopify/Product/test-2",
      shopifyVariantId: "gid://shopify/ProductVariant/test-2"
    })
  ]);
});

after(async () => {
  await Product.deleteMany({ shop: TEST_SHOP });
  await mongoose.disconnect();
});

test("findExactSkuMatch resolves an exact, available SKU", async () => {
  const match = await findExactSkuMatch({ shop: TEST_SHOP, query: "TEST-SKU-001" });
  assert.ok(match);
  assert.equal(match.sku, "TEST-SKU-001");
});

test("findExactSkuMatch is case-insensitive", async () => {
  const match = await findExactSkuMatch({ shop: TEST_SHOP, query: "test-sku-001" });
  assert.ok(match);
  assert.equal(match.sku, "TEST-SKU-001");
});

test("findExactSkuMatch returns null for an out-of-stock exact SKU (availability filtering preserved)", async () => {
  const match = await findExactSkuMatch({ shop: TEST_SHOP, query: "TEST-SKU-002" });
  assert.equal(match, null);
});

test("findExactSkuMatch returns null for a SKU that does not exist", async () => {
  const match = await findExactSkuMatch({ shop: TEST_SHOP, query: "NO-SUCH-SKU" });
  assert.equal(match, null);
});

test("findExactSkuMatch returns null for a query containing whitespace", async () => {
  const match = await findExactSkuMatch({ shop: TEST_SHOP, query: "TEST-SKU-001 extra words" });
  assert.equal(match, null);
});

test("findExactSkuMatch is shop-scoped — a real SKU from a different shop never matches", async () => {
  const match = await findExactSkuMatch({ shop: "some-other-shop.myshopify.com", query: "TEST-SKU-001" });
  assert.equal(match, null);
});

test("searchProducts short-circuits on an exact SKU with resultType 'direct'", async () => {
  const result = await searchProducts({ shop: TEST_SHOP, query: "TEST-SKU-001" });
  assert.equal(result.intent, "product_search");
  assert.equal(result.resultType, "direct");
  assert.deepEqual(result.products.map(p => p.sku), ["TEST-SKU-001"]);
});

test("searchProducts applies an exclude goal even to an exact-SKU match", async () => {
  // Directly exercises the applyGoalRule() call inside the
  // short-circuit branch, without needing a real Goal document.
  const Goal = require("../src/models/Goal");
  await Goal.deleteOne({ shop: TEST_SHOP });
  await Goal.create({
    shop: TEST_SHOP,
    name: "test exclude",
    ruleType: "exclude",
    skus: ["TEST-SKU-001"],
    products: [],
    enabled: true
  });

  try {
    const result = await searchProducts({ shop: TEST_SHOP, query: "TEST-SKU-001" });
    assert.deepEqual(result.products, []);
  } finally {
    await Goal.deleteOne({ shop: TEST_SHOP });
  }
});
