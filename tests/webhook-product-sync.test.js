const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const {
  webhookUpsertProduct,
  webhookDeleteProduct
} = require("../src/controllers/internal-product.controller");
const { webhookUpdateInventory } = require("../src/controllers/internal-inventory.controller");

// =========================================================
// DB-backed. Automatic product sync / webhooks.
//
// webhookUpsertProduct also calls Ollama (embeddings) + Qdrant on
// every non-empty variant list, with no way to skip it — unlike
// webhookDeleteProduct/webhookUpdateInventory, whose Qdrant/Mongo
// calls are conditional and either not reached, or wrapped in a
// non-fatal try/catch that leaves MongoDB's already-correct state
// observable either way. So this suite covers what's safely
// testable without depending on live Ollama/Qdrant reachability
// (validation, and the Mongo-only paths); the full
// create -> embed -> Qdrant -> update -> variant-removal ->
// delete round trip (including confirming Qdrant actually stays
// in sync) was verified live against real Mongo + Qdrant + Ollama
// separately — see the summary of this change, same precedent as
// tests/qdrant.delete-points.test.js.
// =========================================================

const TEST_SHOP = "test-shop-webhook-sync.myshopify.com";
const OTHER_SHOP = "test-shop-webhook-sync-other.myshopify.com";

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
  shopifyProductId: `gid://shopify/Product/webhook-${overrides.id}`,
  shopifyVariantId: `gid://shopify/ProductVariant/webhook-${overrides.id}`,
  matchKey: overrides.sku || `variant:gid://shopify/ProductVariant/webhook-${overrides.id}`,
  sku: overrides.sku || "",
  title: overrides.title || "Test Product",
  availableForSale: true,
  inventoryQuantity: 10,
  shopifyInventoryItemId: overrides.shopifyInventoryItemId || "",
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

// ---------------------------------------------------------
// webhookUpsertProduct — validation only (no network dependency)
// ---------------------------------------------------------

test("webhookUpsertProduct: rejects a request with no shop", async () => {
  const req = { body: { product: { id: "gid://shopify/Product/1" } } };
  const res = makeRes();
  await webhookUpsertProduct(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test("webhookUpsertProduct: rejects a request with no product", async () => {
  const req = { body: { shop: TEST_SHOP } };
  const res = makeRes();
  await webhookUpsertProduct(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

// ---------------------------------------------------------
// webhookDeleteProduct — Mongo behavior is fully observable even
// if Qdrant is unreachable (deleteProductPoints is wrapped in a
// non-fatal try/catch), so this is safe for the always-run suite.
// ---------------------------------------------------------

test("webhookDeleteProduct: rejects a request with no shop", async () => {
  const req = { body: { shopifyProductId: "gid://shopify/Product/1" } };
  const res = makeRes();
  await webhookDeleteProduct(req, res);
  assert.equal(res.statusCode, 400);
});

test("webhookDeleteProduct: rejects a request with no shopifyProductId", async () => {
  const req = { body: { shop: TEST_SHOP } };
  const res = makeRes();
  await webhookDeleteProduct(req, res);
  assert.equal(res.statusCode, 400);
});

test("webhookDeleteProduct: deleting a product with no matching variants is a safe no-op", async () => {
  const req = { body: { shop: TEST_SHOP, shopifyProductId: "gid://shopify/Product/does-not-exist" } };
  const res = makeRes();
  await webhookDeleteProduct(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.variantsRemoved, 0);
});

test("webhookDeleteProduct: removes only the target product's variants, never another product's", async () => {
  const targetProductId = "gid://shopify/Product/webhook-delete-target";
  const otherProductId = "gid://shopify/Product/webhook-delete-untouched";

  await Product.create([
    baseProduct({ id: "delete-target-1", shopifyProductId: targetProductId, sku: "DEL-TARGET-1" }),
    baseProduct({ id: "delete-target-2", shopifyProductId: targetProductId, sku: "DEL-TARGET-2" }),
    baseProduct({ id: "delete-untouched-1", shopifyProductId: otherProductId, sku: "DEL-UNTOUCHED-1" })
  ]);

  const req = { body: { shop: TEST_SHOP, shopifyProductId: targetProductId } };
  const res = makeRes();
  await webhookDeleteProduct(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.variantsRemoved, 2);

  const remaining = await Product.find({ shop: TEST_SHOP }).select("sku").lean();
  assert.deepEqual(remaining.map(p => p.sku).sort(), ["DEL-UNTOUCHED-1"]);

  await Product.deleteMany({ shop: TEST_SHOP });
});

test("webhookDeleteProduct: never touches a same-named product in a different shop", async () => {
  const sharedProductId = "gid://shopify/Product/webhook-shared-id";

  await Product.create([
    baseProduct({ id: "cross-shop-a", shop: TEST_SHOP, shopifyProductId: sharedProductId, sku: "CROSS-SHOP-A" }),
    baseProduct({ id: "cross-shop-b", shop: OTHER_SHOP, shopifyProductId: sharedProductId, sku: "CROSS-SHOP-B" })
  ]);

  const req = { body: { shop: TEST_SHOP, shopifyProductId: sharedProductId } };
  const res = makeRes();
  await webhookDeleteProduct(req, res);

  assert.equal(res.body.data.variantsRemoved, 1);

  const otherShopStillThere = await Product.findOne({ shop: OTHER_SHOP, sku: "CROSS-SHOP-B" }).lean();
  assert.ok(otherShopStillThere, "the other shop's product with the same Shopify product ID must survive");

  await Product.deleteMany({ shop: { $in: [TEST_SHOP, OTHER_SHOP] } });
});

// ---------------------------------------------------------
// webhookUpdateInventory — pure Mongo, no Qdrant call at all ever
// ---------------------------------------------------------

test("webhookUpdateInventory: rejects a request with no shop", async () => {
  const req = { body: { shopifyInventoryItemId: "gid://shopify/InventoryItem/1", available: 5 } };
  const res = makeRes();
  await webhookUpdateInventory(req, res);
  assert.equal(res.statusCode, 400);
});

test("webhookUpdateInventory: rejects a request with no shopifyInventoryItemId", async () => {
  const req = { body: { shop: TEST_SHOP, available: 5 } };
  const res = makeRes();
  await webhookUpdateInventory(req, res);
  assert.equal(res.statusCode, 400);
});

test("webhookUpdateInventory: updates availableForSale and inventoryQuantity for the matching variant", async () => {
  const inventoryItemId = "gid://shopify/InventoryItem/inv-test-1";

  await Product.create(
    baseProduct({
      id: "inv-1",
      sku: "INV-TEST-1",
      shopifyInventoryItemId: inventoryItemId,
      availableForSale: true,
      inventoryQuantity: 20
    })
  );

  const req = { body: { shop: TEST_SHOP, shopifyInventoryItemId: inventoryItemId, available: 0 } };
  const res = makeRes();
  await webhookUpdateInventory(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.modified, 1);

  const updated = await Product.findOne({ shop: TEST_SHOP, sku: "INV-TEST-1" }).lean();
  assert.equal(updated.availableForSale, false);
  assert.equal(updated.inventoryQuantity, 0);

  await Product.deleteMany({ shop: TEST_SHOP });
});

test("webhookUpdateInventory: restocking flips availableForSale back to true", async () => {
  const inventoryItemId = "gid://shopify/InventoryItem/inv-test-2";

  await Product.create(
    baseProduct({
      id: "inv-2",
      sku: "INV-TEST-2",
      shopifyInventoryItemId: inventoryItemId,
      availableForSale: false,
      inventoryQuantity: 0
    })
  );

  const req = { body: { shop: TEST_SHOP, shopifyInventoryItemId: inventoryItemId, available: 15 } };
  const res = makeRes();
  await webhookUpdateInventory(req, res);

  const updated = await Product.findOne({ shop: TEST_SHOP, sku: "INV-TEST-2" }).lean();
  assert.equal(updated.availableForSale, true);
  assert.equal(updated.inventoryQuantity, 15);

  await Product.deleteMany({ shop: TEST_SHOP });
});

test("webhookUpdateInventory: an unknown inventory item id matches nothing and is not an error", async () => {
  const req = { body: { shop: TEST_SHOP, shopifyInventoryItemId: "gid://shopify/InventoryItem/does-not-exist", available: 5 } };
  const res = makeRes();
  await webhookUpdateInventory(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.matched, 0);
});

test("webhookUpdateInventory: only updates the matching shop, never another shop's variant with the same inventory item id", async () => {
  const sharedInventoryItemId = "gid://shopify/InventoryItem/shared-inv";

  await Product.create([
    baseProduct({ id: "cross-shop-inv-a", shop: TEST_SHOP, sku: "CROSS-INV-A", shopifyInventoryItemId: sharedInventoryItemId, availableForSale: true, inventoryQuantity: 5 }),
    baseProduct({ id: "cross-shop-inv-b", shop: OTHER_SHOP, sku: "CROSS-INV-B", shopifyInventoryItemId: sharedInventoryItemId, availableForSale: true, inventoryQuantity: 5 })
  ]);

  const req = { body: { shop: TEST_SHOP, shopifyInventoryItemId: sharedInventoryItemId, available: 0 } };
  const res = makeRes();
  await webhookUpdateInventory(req, res);

  assert.equal(res.body.data.matched, 1);

  const otherShopVariant = await Product.findOne({ shop: OTHER_SHOP, sku: "CROSS-INV-B" }).lean();
  assert.equal(otherShopVariant.inventoryQuantity, 5, "the other shop's matching inventory item id must be untouched");

  await Product.deleteMany({ shop: { $in: [TEST_SHOP, OTHER_SHOP] } });
});
