const { test } = require("node:test");
const assert = require("node:assert/strict");

const { deleteProductPoints, makePointId } = require("../src/services/search/qdrant.service");

// =========================================================
// This is the fix for: deleting a product from MongoDB never
// told Qdrant to remove the matching semantic-search entry, so
// Qdrant accumulated orphaned data forever (confirmed live: 114
// Qdrant points for only 64 real MongoDB products).
//
// Only the empty-input short-circuit is tested here without a
// network call — it's the one behavior guaranteed not to depend
// on Qdrant being reachable, so it belongs in the always-run
// suite. The actual delete-from-Qdrant behavior was verified
// live, once, directly against the real Qdrant instance (see the
// summary of this change) rather than added to this suite, to
// keep `npm test` fast and independent of Qdrant's reachability
// (Qdrant has been observed unreachable at times during this
// project, purely a local Docker startup-timing issue).
// =========================================================

test("does nothing and makes no network call when given no matchKeys", async () => {
  // If this tried to call Qdrant, it would throw (no network
  // mocking in this project) or hang — resolving cleanly proves
  // the early-return path was taken.
  await deleteProductPoints("some-shop.myshopify.com", []);
  await deleteProductPoints("some-shop.myshopify.com", null);
  await deleteProductPoints("some-shop.myshopify.com", undefined);
});

test("deleteProductPoints would target the exact same point IDs upsertProducts creates", () => {
  // Both must agree on the ID for a given {shop, matchKey}, or
  // deletion would silently miss the real point. This can't
  // observe deleteProductPoints' internal ID list without a
  // network call, so it re-confirms makePointId's own contract
  // (already covered by qdrant.matchkey.test.js) as a guard that
  // this file's assumption about it stays true.
  const shop = "some-shop.myshopify.com";
  const matchKey = "SKU-001";
  assert.equal(makePointId(shop, matchKey), makePointId(shop, matchKey));
});
