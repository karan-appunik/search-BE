const { test } = require("node:test");
const assert = require("node:assert/strict");

const { getGLMCacheKey } = require("../src/services/ai/ai.service");

// =========================================================
// Pure function — no network. This is the fix for: the GLM
// result cache key did not include the shop, so two different
// shops with an identical query AND an identical sorted-SKU
// candidate set could in principle share a cached recommendation.
// =========================================================

test("two different shops with the same query and catalog get different cache keys", () => {
  const catalog = [{ sku: "A" }, { sku: "B" }];
  const keyShopA = getGLMCacheKey("shop-a.myshopify.com", "black dress", catalog);
  const keyShopB = getGLMCacheKey("shop-b.myshopify.com", "black dress", catalog);
  assert.notEqual(keyShopA, keyShopB);
});

test("the same shop, query, and catalog produce the same cache key (cache hits still work)", () => {
  const catalog = [{ sku: "A" }, { sku: "B" }];
  const key1 = getGLMCacheKey("shop-a.myshopify.com", "black dress", catalog);
  const key2 = getGLMCacheKey("shop-a.myshopify.com", "black dress", catalog);
  assert.equal(key1, key2);
});

test("catalog order does not affect the key (SKUs are sorted before hashing)", () => {
  const key1 = getGLMCacheKey("shop-a.myshopify.com", "black dress", [{ sku: "A" }, { sku: "B" }]);
  const key2 = getGLMCacheKey("shop-a.myshopify.com", "black dress", [{ sku: "B" }, { sku: "A" }]);
  assert.equal(key1, key2);
});
