const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const {
  resolveUnavailableDirectMatch,
  applySemanticFallbackIfNoRecommendations
} = require("../src/services/search/search.service");

// =========================================================
// This is the fix for: the full/submitted search had no
// out-of-stock-alternative safety net that the live preview
// search already had, so the two modes could classify the same
// situation differently (or final mode could return nothing
// where preview would show alternatives).
//
// Both functions here never call GLM or Qdrant — Qdrant
// candidates are passed in as plain data, never fetched — so
// this suite is fast and fully deterministic. resolveUnavailableDirectMatch
// does one Mongo availability lookup; applySemanticFallbackIfNoRecommendations
// is pure and needs no DB at all.
// =========================================================

const TEST_SHOP = "test-shop-recommended-consistency.myshopify.com";

const baseProduct = (overrides) => ({
  shop: TEST_SHOP,
  shopifyProductId: `gid://shopify/Product/${overrides.sku}`,
  shopifyVariantId: `gid://shopify/ProductVariant/${overrides.sku}`,
  availableForSale: true,
  inventoryQuantity: 10,
  ...overrides,
  matchKey: overrides.matchKey || overrides.sku || ""
});

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Product.deleteMany({ shop: TEST_SHOP });

  await Product.create([
    baseProduct({ sku: "REC-001", title: "Red Lipstick Wedding Edition" }),
    baseProduct({ sku: "REC-004", title: "Berry Plum Lipstick" }),
    baseProduct({ sku: "REC-005", title: "Matte Red Lipstick", availableForSale: false }),
    baseProduct({
      sku: "",
      matchKey: "variant:rec-skuless",
      title: "Emerald Silk Scarf",
      shopifyProductId: "gid://shopify/Product/rec-skuless",
      shopifyVariantId: "gid://shopify/ProductVariant/rec-skuless"
    })
  ]);
});

after(async () => {
  await Product.deleteMany({ shop: TEST_SHOP });
  await mongoose.disconnect();
});

// =========================================================
// resolveUnavailableDirectMatch
// =========================================================

test("available product with strong title overlap -> resultType 'direct'", async () => {
  const candidates = [{ sku: "REC-001", matchKey: "REC-001", title: "Red Lipstick Wedding Edition" }];
  const result = await resolveUnavailableDirectMatch({
    shop: TEST_SHOP,
    query: "red lipstick",
    candidates,
    lexicalCandidates: [],
    semanticCandidates: [],
    aiResult: { recommendations: [{ sku: "REC-001", score: 90 }] }
  });
  assert.equal(result.resultType, "direct");
});

test("available product with weak/no title overlap -> resultType 'recommended'", async () => {
  const candidates = [{ sku: "REC-004", matchKey: "REC-004", title: "Berry Plum Lipstick" }];
  const result = await resolveUnavailableDirectMatch({
    shop: TEST_SHOP,
    query: "good lipstick for a special occasion",
    candidates,
    lexicalCandidates: [],
    semanticCandidates: [],
    aiResult: { recommendations: [{ sku: "REC-004", score: 80 }] }
  });
  assert.equal(result.resultType, "recommended");
});

test("unavailable direct match with semantic alternatives -> resultType 'alternative', excludes the unavailable SKU itself", async () => {
  const candidates = [{ sku: "REC-005", matchKey: "REC-005", title: "Matte Red Lipstick" }];
  const semanticCandidates = [
    { sku: "REC-006", matchKey: "REC-006", title: "Nude Lipstick", _semanticScore: 0.5 },
    { sku: "REC-005", matchKey: "REC-005", title: "Matte Red Lipstick", _semanticScore: 0.9 }
  ];
  const result = await resolveUnavailableDirectMatch({
    shop: TEST_SHOP,
    query: "red lipstick",
    candidates,
    lexicalCandidates: [],
    semanticCandidates,
    aiResult: { recommendations: [{ sku: "REC-005", score: 85 }] }
  });
  assert.equal(result.resultType, "alternative");
  assert.equal(result.message, "We didn't find exactly that, but you might like these");
  const skus = result.recommendations.map(r => r.sku);
  assert.ok(skus.includes("REC-006"));
  assert.ok(!skus.includes("REC-005"), "the unavailable SKU itself must not reappear as its own alternative");
});

test("unavailable direct match with no usable alternatives -> resultType 'none', intent 'no_match'", async () => {
  const candidates = [{ sku: "REC-005", matchKey: "REC-005", title: "Matte Red Lipstick" }];
  const result = await resolveUnavailableDirectMatch({
    shop: TEST_SHOP,
    query: "red lipstick",
    candidates,
    lexicalCandidates: [],
    semanticCandidates: [],
    aiResult: { recommendations: [{ sku: "REC-005", score: 85 }] }
  });
  assert.equal(result.intent, "no_match");
  assert.equal(result.resultType, "none");
  assert.deepEqual(result.recommendations, []);
});

test("SKU-less product: strong title overlap still resolves to 'direct', matched by matchKey not sku", async () => {
  const candidates = [{ sku: "", matchKey: "variant:rec-skuless", title: "Emerald Silk Scarf" }];
  const result = await resolveUnavailableDirectMatch({
    shop: TEST_SHOP,
    query: "emerald silk scarf",
    candidates,
    lexicalCandidates: [],
    semanticCandidates: [],
    aiResult: { recommendations: [{ sku: "variant:rec-skuless", score: 90 }] }
  });
  assert.equal(result.resultType, "direct");
});

// =========================================================
// applySemanticFallbackIfNoRecommendations
// =========================================================

test("leaves aiResult unchanged when it already has recommendations", () => {
  const aiResult = { intent: "product_search", resultType: "direct", recommendations: [{ sku: "X" }] };
  const result = applySemanticFallbackIfNoRecommendations({
    aiResult,
    semanticCandidates: [{ sku: "Y", matchKey: "Y", _semanticScore: 0.9 }]
  });
  assert.equal(result, aiResult);
});

test("leaves aiResult unchanged when there are no semantic candidates either", () => {
  const aiResult = { intent: "no_match", recommendations: [] };
  const result = applySemanticFallbackIfNoRecommendations({ aiResult, semanticCandidates: [] });
  assert.equal(result, aiResult);
});

test("substitutes semantic alternatives when GLM found nothing and a candidate clears the threshold", () => {
  const aiResult = { intent: "no_match", recommendations: [] };
  const result = applySemanticFallbackIfNoRecommendations({
    aiResult,
    semanticCandidates: [{ sku: "ALT-1", matchKey: "ALT-1", title: "Alt One", _semanticScore: 0.5 }]
  });
  assert.equal(result.resultType, "alternative");
  assert.equal(result.message, "We didn't find exactly that, but you might like these");
  assert.deepEqual(result.recommendations.map(r => r.sku), ["ALT-1"]);
});

test("a substituted candidate with strong title overlap is labeled 'recommended', not 'alternative' — no fallback message", () => {
  // Real reported bug: query "band t-shirt" finding a product
  // literally named "...Band...T-Shirt" still showed "we didn't
  // find exactly that" because GLM itself returned nothing and
  // the substitution path always said "alternative" unconditionally.
  const aiResult = { intent: "no_match", recommendations: [] };
  const result = applySemanticFallbackIfNoRecommendations({
    query: "band t-shirt",
    aiResult,
    semanticCandidates: [
      { sku: "BAND-1", matchKey: "BAND-1", title: "Physical Product “The Band” T-Shirt", _semanticScore: 0.55 }
    ]
  });
  assert.equal(result.resultType, "recommended");
  assert.equal(result.message, undefined, "no fallback banner for a genuinely relevant result");
  assert.deepEqual(result.recommendations.map(r => r.sku), ["BAND-1"]);
});

test("a substituted candidate with weak/no title overlap still correctly gets 'alternative' and the fallback message", () => {
  const aiResult = { intent: "no_match", recommendations: [] };
  const result = applySemanticFallbackIfNoRecommendations({
    query: "something completely unrelated",
    aiResult,
    semanticCandidates: [{ sku: "ALT-1", matchKey: "ALT-1", title: "Alt One", _semanticScore: 0.5 }]
  });
  assert.equal(result.resultType, "alternative");
  assert.equal(result.message, "We didn't find exactly that, but you might like these");
});

test("leaves aiResult unchanged when no semantic candidate clears the similarity threshold", () => {
  const aiResult = { intent: "no_match", recommendations: [] };
  const result = applySemanticFallbackIfNoRecommendations({
    aiResult,
    semanticCandidates: [{ sku: "ALT-1", matchKey: "ALT-1", title: "Alt One", _semanticScore: 0.01 }]
  });
  assert.equal(result, aiResult);
});

test("caps substituted alternatives at 6 even when more clear the threshold", () => {
  const aiResult = { intent: "no_match", recommendations: [] };
  const semanticCandidates = Array.from({ length: 8 }, (_, i) => ({
    sku: `ALT-${i}`,
    matchKey: `ALT-${i}`,
    title: `Alt ${i}`,
    _semanticScore: 0.9
  }));
  const result = applySemanticFallbackIfNoRecommendations({ aiResult, semanticCandidates });
  assert.equal(result.recommendations.length, 6);
});

test("SKU-less semantic candidate is used as a fallback alternative, matched by matchKey", () => {
  const aiResult = { intent: "no_match", recommendations: [] };
  const result = applySemanticFallbackIfNoRecommendations({
    aiResult,
    semanticCandidates: [{ sku: "", matchKey: "variant:alt-skuless", title: "Alt Skuless", _semanticScore: 0.5 }]
  });
  assert.equal(result.resultType, "alternative");
  assert.deepEqual(result.recommendations.map(r => r.sku), ["variant:alt-skuless"]);
});
