const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const { resolveUnavailableDirectMatch } = require("../src/services/search/search.service");

// =========================================================
// This is the fix for a real, reported bug: a customer typing
// "suggest me good dress" (or "recommend a dress") got the
// "we didn't find exactly that" fallback banner even though the
// exact right dresses were returned — because "suggest" and
// "recommend" were not in the app's stop-word list, so they
// counted as words that MUST appear in a product's title for it
// to count as a genuine direct match. Since no product title
// will ever contain the word "suggest", every such query was
// silently mislabeled as "recommended" instead of "direct".
//
// "suggest"/"suggest me"/"recommend"/"recommend me" were already
// recognized elsewhere in this file as pure customer-intent
// phrasing (see conversationalStarts) — this fix just makes the
// stop-word list agree with that, instead of the two lists
// silently disagreeing.
// =========================================================

const TEST_SHOP = "test-shop-direct-match-classification.myshopify.com";

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Product.deleteMany({ shop: TEST_SHOP });
  await Product.create([
    {
      shop: TEST_SHOP,
      sku: "DRESS-001",
      matchKey: "DRESS-001",
      shopifyProductId: "gid://shopify/Product/DRESS-001",
      shopifyVariantId: "gid://shopify/ProductVariant/DRESS-001",
      title: "Black Evening Slip Dress",
      availableForSale: true
    }
  ]);
});

after(async () => {
  await Product.deleteMany({ shop: TEST_SHOP });
  await mongoose.disconnect();
});

async function classify(query) {
  const candidates = [{ sku: "DRESS-001", matchKey: "DRESS-001", title: "Black Evening Slip Dress" }];
  const result = await resolveUnavailableDirectMatch({
    shop: TEST_SHOP,
    query,
    candidates,
    lexicalCandidates: candidates,
    semanticCandidates: [],
    aiResult: { recommendations: [{ sku: "DRESS-001", score: 90 }] }
  });
  return result.resultType;
}

test("'suggest me good dress' is classified as a direct match, not 'recommended'", async () => {
  assert.equal(await classify("suggest me good dress"), "direct");
});

test("'recommend a dress' is classified as a direct match, not 'recommended'", async () => {
  assert.equal(await classify("recommend a dress"), "direct");
});

test("a plain, non-intent query for the same product is still classified as direct (no regression)", async () => {
  assert.equal(await classify("black evening dress"), "direct");
});
