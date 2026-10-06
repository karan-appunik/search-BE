const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const {
  upsertProducts,
  searchByVector,
  deleteProductPoints
} = require("../src/services/search/vector.service");

// =========================================================
// DB-backed. Vector search now runs on vectors stored in
// MongoDB (vector.service.js), replacing the external Qdrant
// service. Uses tiny hand-made vectors, so no embedding model
// is needed.
// =========================================================

const SHOP = "test-shop-vector-search.myshopify.com";
const OTHER_SHOP = "test-shop-vector-search-other.myshopify.com";

const product = (shop, id, title, sku = "") => ({
  shop,
  sku,
  matchKey: sku || `variant:gid://shopify/ProductVariant/vec-${id}`,
  shopifyProductId: `gid://shopify/Product/vec-${id}`,
  shopifyVariantId: `gid://shopify/ProductVariant/vec-${id}`,
  title,
  availableForSale: true
});

let docs;

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Product.deleteMany({ shop: { $in: [SHOP, OTHER_SHOP] } });

  docs = await Product.create([
    product(SHOP, "jacket", "Denim Jacket", "VEC-JACKET"),
    product(SHOP, "coat", "Wool Coat", "VEC-COAT"),
    product(SHOP, "mug", "Coffee Mug"), // SKU-less
    product(SHOP, "novector", "Product Without Vector", "VEC-NONE"),
    product(OTHER_SHOP, "other", "Other Shop Jacket", "VEC-OTHER")
  ]);

  const [jacket, coat, mug, , other] = docs.map(doc => doc.toObject());

  await upsertProducts(
    [jacket, coat, mug, other],
    [
      [1, 0, 0],
      [0.8, 0.6, 0],
      [0, 0, 1],
      [1, 0, 0]
    ]
  );
});

after(async () => {
  await Product.deleteMany({ shop: { $in: [SHOP, OTHER_SHOP] } });
  await mongoose.disconnect();
});

test("returns products ordered by cosine similarity, with scores on the same 0..1 scale", async () => {
  const results = await searchByVector([1, 0, 0], { shop: SHOP, limit: 10 });

  assert.deepEqual(results.map(r => r.payload.title), ["Denim Jacket", "Wool Coat", "Coffee Mug"]);
  assert.ok(Math.abs(results[0].score - 1) < 1e-6);
  assert.ok(Math.abs(results[1].score - 0.8) < 1e-6);
  assert.ok(Math.abs(results[2].score) < 1e-6);
});

test("is shop-scoped: another shop's identical vector never appears", async () => {
  const results = await searchByVector([1, 0, 0], { shop: SHOP, limit: 10 });
  assert.ok(!results.some(r => r.payload.shop === OTHER_SHOP));

  const other = await searchByVector([1, 0, 0], { shop: OTHER_SHOP, limit: 10 });
  assert.deepEqual(other.map(r => r.payload.matchKey), ["VEC-OTHER"]);
});

test("a SKU-less product is returned with its variant matchKey", async () => {
  const results = await searchByVector([0, 0, 1], { shop: SHOP, limit: 1 });
  assert.equal(results[0].payload.sku, "");
  assert.equal(results[0].payload.matchKey, "variant:gid://shopify/ProductVariant/vec-mug");
});

test("products without a stored vector are ignored", async () => {
  const results = await searchByVector([1, 0, 0], { shop: SHOP, limit: 10 });
  assert.ok(!results.some(r => r.payload.matchKey === "VEC-NONE"));
});

test("respects the limit", async () => {
  const results = await searchByVector([1, 0, 0], { shop: SHOP, limit: 2 });
  assert.equal(results.length, 2);
});

test("normal product queries never load the (large) embedding field", async () => {
  const plain = await Product.findOne({ shop: SHOP, sku: "VEC-JACKET" }).lean();
  assert.equal(plain.embedding, undefined);
  assert.equal(plain.hasEmbedding, true);
});

test("a deleted product disappears from results after deleteProductPoints", async () => {
  await Product.deleteOne({ shop: SHOP, sku: "VEC-COAT" });
  await deleteProductPoints(SHOP, ["VEC-COAT"]);

  const results = await searchByVector([1, 0, 0], { shop: SHOP, limit: 10 });
  assert.ok(!results.some(r => r.payload.matchKey === "VEC-COAT"));
});

test("throws without a shop; returns [] for an empty embedding", async () => {
  await assert.rejects(() => searchByVector([1, 0, 0], { limit: 5 }), /shop is required/i);
  assert.deepEqual(await searchByVector([], { shop: SHOP }), []);
  await deleteProductPoints(SHOP, []); // no-op, no throw
});
