const { test } = require("node:test");
const assert = require("node:assert/strict");

const { makePointId } = require("../src/services/search/qdrant.service");

// =========================================================
// Pure function — no network, no Qdrant connection needed.
//
// This is the fix for: every SKU-less product's Qdrant point ID
// used to be built from an empty sku, so every SKU-less product
// in the same shop hashed to the exact same point ID and
// silently overwrote each other's semantic search entry, one
// at a time, down to whichever was embedded last.
// =========================================================

const SHOP = "matchkey-test-shop.myshopify.com";

test("two SKU-less products (different matchKeys) get different point IDs — no collision", () => {
  const idA = makePointId(SHOP, "variant:gid://shopify/ProductVariant/1");
  const idB = makePointId(SHOP, "variant:gid://shopify/ProductVariant/2");
  assert.notEqual(idA, idB);
});

test("a real-SKU product's point ID is unaffected — same formula as before, keyed by matchKey which equals the sku", () => {
  const id = makePointId(SHOP, "SKU-001");
  const idAgain = makePointId(SHOP, "SKU-001");
  assert.equal(id, idAgain, "deterministic: same shop + matchKey always produces the same point ID");
});

test("point ID is deterministic and stable across repeated calls for the same SKU-less product", () => {
  const matchKey = "variant:gid://shopify/ProductVariant/999";
  const first = makePointId(SHOP, matchKey);
  const second = makePointId(SHOP, matchKey);
  assert.equal(first, second, "re-embedding the same SKU-less product must update the same point, not create a new one");
});

test("the same matchKey in two different shops still produces different point IDs (shop-scoped)", () => {
  const idShopA = makePointId("shop-a.myshopify.com", "variant:gid://shopify/ProductVariant/1");
  const idShopB = makePointId("shop-b.myshopify.com", "variant:gid://shopify/ProductVariant/1");
  assert.notEqual(idShopA, idShopB);
});

test("produces a valid UUID-shaped point ID (Qdrant requires this format)", () => {
  const id = makePointId(SHOP, "SKU-001");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
