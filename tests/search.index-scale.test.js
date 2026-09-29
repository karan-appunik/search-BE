const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");

// =========================================================
// This is the fix for: findPrefixCandidates() and
// findPartialCandidates() in search.service.js both filter on
// { shop, availableForSale: true } before doing their
// word-matching, but there was no database index backing that
// filter — only a plain index on `shop` alone. At 10,000+
// products per shop, every one of those searches would have to
// check every single product for that shop, in stock or not,
// one by one.
//
// This is a structural check only (does the index exist) —
// fast and deterministic, so it belongs in the regular test
// suite. The actual ~10,000-product timing proof was done
// separately as a one-off benchmark (not part of this suite,
// since inserting 10,000 documents on every test run would slow
// down the whole suite for everyone).
// =========================================================

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  // Mongoose creates schema-declared indexes in the background on
  // connect (autoIndex, on by default); make sure it has finished
  // before asserting on it.
  await Product.init();
});

after(async () => {
  await mongoose.disconnect();
});

test("a shop+availability index exists on the products collection", async () => {
  const indexes = await Product.collection.indexes();
  const hasShopAvailabilityIndex = indexes.some(index => {
    const keys = Object.keys(index.key || {});
    return keys.includes("shop") && keys.includes("availableForSale");
  });

  assert.ok(
    hasShopAvailabilityIndex,
    "expected an index covering both shop and availableForSale — without it, findPrefixCandidates/findPartialCandidates must scan every product for a shop, in stock or not"
  );
});

test("MongoDB's query planner actually uses that index for the exact filter findPrefixCandidates/findPartialCandidates use", async () => {
  const explanation = await Product.find({
    shop: "any-shop-name-doesnt-need-to-exist.myshopify.com",
    availableForSale: true
  })
    .explain("queryPlanner");

  const winningPlanJson = JSON.stringify(explanation.queryPlanner.winningPlan);

  assert.ok(
    winningPlanJson.includes("IXSCAN"),
    "expected the query plan to use an index scan (IXSCAN), not a full collection scan (COLLSCAN), for the shop+availableForSale filter"
  );
  assert.ok(
    !winningPlanJson.includes("COLLSCAN"),
    "did not expect a full collection scan anywhere in the winning plan"
  );
});
