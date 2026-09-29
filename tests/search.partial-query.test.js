const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const { findPartialCandidates } = require("../src/services/search/search.service");

// =========================================================
// DB-backed only — never touches GLM/Qdrant, since
// findPartialCandidates() is a plain MongoDB regex search.
//
// This is the fix for: a long, natural-language query used to
// only search using its LAST 3 meaningful words (after removing
// filler words like "i", "want", "for"), silently discarding
// everything before that — so a customer's actual product-type
// word ("serum") could be dropped just because it wasn't near
// the end of the sentence. The fix widens this to the last 10
// meaningful words. This suite proves the real customer-facing
// symptom is gone, that the old short-query behavior is
// unaffected, and that the cap still exists (it isn't unbounded).
// =========================================================

const TEST_SHOP = "test-shop-partial-query.myshopify.com";

const baseProduct = (overrides) => ({
  shop: TEST_SHOP,
  shopifyProductId: `gid://shopify/Product/${overrides.sku}`,
  shopifyVariantId: `gid://shopify/ProductVariant/${overrides.sku}`,
  availableForSale: true,
  inventoryQuantity: 10,
  description: "",
  tags: [],
  ...overrides,
  matchKey: overrides.matchKey || overrides.sku || ""
});

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  await Product.deleteMany({ shop: TEST_SHOP });

  await Product.create([
    baseProduct({
      sku: "PARTIAL-001",
      title: "Vitamin C Brightening Serum",
      productType: "Serum",
      tags: ["vitamin-c", "brightening", "serum", "antioxidant"],
      description: "A lightweight serum for brightening."
      // Deliberately contains none of "dark", "spots" or
      // "hyperpigmentation" — those are the trailing words the
      // OLD (last-3-words) code would have used instead of
      // "serum"/"brightening"/"vitamin"/"lightweight".
    }),
    baseProduct({
      sku: "PARTIAL-002",
      title: "Gadgetword Widget",
      productType: "Gadget",
      tags: ["gadgetword"],
      availableForSale: true
    }),
    baseProduct({
      sku: "PARTIAL-003",
      title: "Unavailable Serum",
      productType: "Serum",
      tags: ["serum"],
      availableForSale: false
    })
  ]);
});

after(async () => {
  await Product.deleteMany({ shop: TEST_SHOP });
  await mongoose.disconnect();
});

test("a long natural-language query no longer drops the customer's key word (the actual fix)", async () => {
  const query = "I want a lightweight vitamin C serum for brightening dark spots and hyperpigmentation";
  const result = await findPartialCandidates({ shop: TEST_SHOP, query });
  assert.ok(
    result.some(product => product.sku === "PARTIAL-001"),
    "expected the serum to be found via 'serum'/'brightening', not silently dropped in favor of only the trailing words"
  );
});

test("a short natural-language query still works exactly as before (no regression)", async () => {
  const query = "I want a serum";
  const result = await findPartialCandidates({ shop: TEST_SHOP, query });
  assert.ok(result.some(product => product.sku === "PARTIAL-001"));
});

test("out-of-stock products are still excluded — availability filtering untouched", async () => {
  const query = "I want a serum";
  const result = await findPartialCandidates({ shop: TEST_SHOP, query });
  assert.ok(!result.some(product => product.sku === "PARTIAL-003"));
});

test("the word cap still exists — a word beyond the last 10 meaningful words is still not searched for", async () => {
  // 13 meaningful words: "gadgetword" is 1st (i.e. 13th-from-the-end),
  // so the last-10 cap should drop it along with the next two fillers.
  const query =
    "gadgetword filler2 filler3 filler4 filler5 filler6 filler7 " +
    "filler8 filler9 filler10 filler11 filler12 filler13";
  const result = await findPartialCandidates({ shop: TEST_SHOP, query });
  assert.ok(
    !result.some(product => product.sku === "PARTIAL-002"),
    "expected 'gadgetword' to fall outside the last-10-words window and not match"
  );
});

test("a word within the last 10 meaningful words is still found", async () => {
  const query =
    "filler1 filler2 filler3 gadgetword filler5 filler6 filler7 " +
    "filler8 filler9 filler10 filler11";
  const result = await findPartialCandidates({ shop: TEST_SHOP, query });
  assert.ok(
    result.some(product => product.sku === "PARTIAL-002"),
    "expected 'gadgetword' to be within the last-10-words window and match"
  );
});
