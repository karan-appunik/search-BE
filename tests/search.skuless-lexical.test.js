const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const {
  findPrefixCandidates,
  findPartialCandidates,
  findExactSkuMatch
} = require("../src/services/search/search.service");

// =========================================================
// A SKU-less product must be just as findable through ordinary
// lexical (word-matching) search as one with a SKU — retrieval
// never filters on sku, only on the searched words and
// availability. DB-only, no GLM/Qdrant.
// =========================================================

const TEST_SHOP = "test-shop-skuless-lexical.myshopify.com";

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Product.deleteMany({ shop: TEST_SHOP });

  await Product.create([
    {
      shop: TEST_SHOP,
      sku: "",
      matchKey: "variant:lex-skuless-1",
      shopifyProductId: "gid://shopify/Product/lex-skuless-1",
      shopifyVariantId: "gid://shopify/ProductVariant/lex-skuless-1",
      title: "Handwoven Bamboo Basket",
      productType: "Basket",
      tags: ["bamboo", "handwoven", "storage"],
      description: "A handwoven bamboo basket for storage.",
      availableForSale: true
    }
  ]);
});

after(async () => {
  await Product.deleteMany({ shop: TEST_SHOP });
  await mongoose.disconnect();
});

test("a SKU-less product is found by prefix search on its title", async () => {
  const results = await findPrefixCandidates({ shop: TEST_SHOP, query: "Handwoven", limit: 10 });
  assert.ok(results.some(p => p.matchKey === "variant:lex-skuless-1"));
});

test("a SKU-less product is found by natural-language partial search", async () => {
  const results = await findPartialCandidates({ shop: TEST_SHOP, query: "I want a bamboo basket" });
  assert.ok(results.some(p => p.matchKey === "variant:lex-skuless-1"));
});

test("a SKU-less product is never returned by an exact-SKU search (nothing to type)", async () => {
  const match = await findExactSkuMatch({ shop: TEST_SHOP, query: "variant:lex-skuless-1" });
  // The matchKey fallback is an internal identifier, not something
  // a customer would type as a SKU — findExactSkuMatch correctly
  // does not treat it as one.
  assert.equal(match, null);
});
