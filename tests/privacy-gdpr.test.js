const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const { upsertGoal, getGoal } = require("../src/services/goal/goal.service");
const { redactShop } = require("../src/controllers/privacy.controller");

// =========================================================
// DB-backed. GDPR: shop/redact.
//
// This is the actual mandatory data-deletion step for the
// shop/redact compliance webhook — deletes a shop's products and
// goal/rule. The Qdrant deletion call is wrapped in a non-fatal
// try/catch (same pattern as webhookDeleteProduct), so this stays
// safe to run without depending on live Qdrant reachability, same
// precedent as tests/qdrant.delete-points.test.js and
// tests/webhook-product-sync.test.js.
// =========================================================

const TEST_SHOP = "test-shop-privacy-redact.myshopify.com";
const OTHER_SHOP = "test-shop-privacy-redact-other.myshopify.com";

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    }
  };
  return res;
}

const baseProduct = (overrides) => ({
  shop: TEST_SHOP,
  shopifyProductId: `gid://shopify/Product/redact-${overrides.id}`,
  shopifyVariantId: `gid://shopify/ProductVariant/redact-${overrides.id}`,
  matchKey: overrides.sku || `variant:gid://shopify/ProductVariant/redact-${overrides.id}`,
  sku: overrides.sku || "",
  title: overrides.title || "Test Product",
  availableForSale: true,
  inventoryQuantity: 10,
  ...overrides
});

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Product.deleteMany({ shop: { $in: [TEST_SHOP, OTHER_SHOP] } });
});

after(async () => {
  await Product.deleteMany({ shop: { $in: [TEST_SHOP, OTHER_SHOP] } });
  await mongoose.disconnect();
});

test("redactShop: rejects a request with no shop", async () => {
  const req = { body: {} };
  const res = makeRes();
  await redactShop(req, res);
  assert.equal(res.statusCode, 400);
});

test("redactShop: a shop with no data at all is a safe no-op", async () => {
  const req = { body: { shop: "test-shop-never-existed.myshopify.com" } };
  const res = makeRes();
  await redactShop(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.productsDeleted, 0);
  assert.equal(res.body.data.goalDeleted, false);
});

test("redactShop: deletes all of the shop's products and its goal", async () => {
  await Product.create([
    baseProduct({ id: "redact-1", sku: "REDACT-1" }),
    baseProduct({ id: "redact-2", sku: "REDACT-2" })
  ]);
  await upsertGoal({
    shop: TEST_SHOP,
    name: "Redact test goal",
    ruleType: "boost",
    skus: ["REDACT-1"],
    products: [{ matchKey: "REDACT-1", title: "Test Product" }],
    enabled: true
  });

  const req = { body: { shop: TEST_SHOP } };
  const res = makeRes();
  await redactShop(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.productsDeleted, 2);
  assert.equal(res.body.data.goalDeleted, true);

  const remainingProducts = await Product.find({ shop: TEST_SHOP }).lean();
  assert.equal(remainingProducts.length, 0);

  const remainingGoal = await getGoal(TEST_SHOP);
  assert.equal(remainingGoal, null);
});

test("redactShop: never touches another shop's products or goal", async () => {
  await Product.create([
    baseProduct({ id: "cross-target", shop: TEST_SHOP, sku: "CROSS-TARGET" }),
    baseProduct({ id: "cross-other", shop: OTHER_SHOP, sku: "CROSS-OTHER" })
  ]);
  await upsertGoal({
    shop: OTHER_SHOP,
    name: "Other shop's goal — must survive",
    ruleType: "exclude",
    skus: ["CROSS-OTHER"],
    products: [{ matchKey: "CROSS-OTHER", title: "Test Product" }],
    enabled: true
  });

  const req = { body: { shop: TEST_SHOP } };
  const res = makeRes();
  await redactShop(req, res);

  assert.equal(res.body.data.productsDeleted, 1);

  const otherShopProduct = await Product.findOne({ shop: OTHER_SHOP, sku: "CROSS-OTHER" }).lean();
  assert.ok(otherShopProduct, "the other shop's product must survive");

  const otherShopGoal = await getGoal(OTHER_SHOP);
  assert.ok(otherShopGoal, "the other shop's goal must survive");
  assert.equal(otherShopGoal.name, "Other shop's goal — must survive");
});

test("redactShop: is idempotent — running it twice is safe", async () => {
  await Product.create(baseProduct({ id: "idempotent-1", sku: "IDEMPOTENT-1" }));

  const req = { body: { shop: TEST_SHOP } };

  const res1 = makeRes();
  await redactShop(req, res1);
  assert.equal(res1.body.data.productsDeleted, 1);

  const res2 = makeRes();
  await redactShop(req, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.data.productsDeleted, 0);
});
