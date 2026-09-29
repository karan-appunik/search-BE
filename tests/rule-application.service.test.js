const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  applyGoalRule,
  isApplicableGoal
} = require("../src/services/rules/rule-application.service");

// =========================================================
// Pure function — no DB, no network. Every test here should
// run instantly and needs nothing but Node itself.
// =========================================================

// matchKey is what applyGoalRule actually matches against (see
// rule-application.service.js) — equal to sku here, matching the
// common case of a product that has a real SKU.
const products = () => [
  { sku: "A", matchKey: "A" },
  { sku: "B", matchKey: "B" },
  { sku: "C", matchKey: "C" },
  { sku: "D", matchKey: "D" }
];

test("no goal is a no-op", () => {
  const result = applyGoalRule({ products: products(), goal: null });
  assert.deepEqual(result.map(p => p.sku), ["A", "B", "C", "D"]);
});

test("disabled goal is a no-op", () => {
  const goal = { enabled: false, ruleType: "boost", skus: ["C"] };
  const result = applyGoalRule({ products: products(), goal });
  assert.deepEqual(result.map(p => p.sku), ["A", "B", "C", "D"]);
});

test("goal with no ruleType chosen yet is a no-op", () => {
  const goal = { enabled: true, ruleType: null, skus: ["C"] };
  const result = applyGoalRule({ products: products(), goal });
  assert.deepEqual(result.map(p => p.sku), ["A", "B", "C", "D"]);
});

test("goal with empty skus is a no-op", () => {
  const goal = { enabled: true, ruleType: "boost", skus: [] };
  const result = applyGoalRule({ products: products(), goal });
  assert.deepEqual(result.map(p => p.sku), ["A", "B", "C", "D"]);
});

test("boost moves the matched product to the front, preserving relative order otherwise", () => {
  const goal = { enabled: true, ruleType: "boost", skus: ["C"] };
  const result = applyGoalRule({ products: products(), goal });
  assert.deepEqual(result.map(p => p.sku), ["C", "A", "B", "D"]);
});

test("demote moves the matched product to the back, preserving relative order otherwise", () => {
  const goal = { enabled: true, ruleType: "demote", skus: ["B"] };
  const result = applyGoalRule({ products: products(), goal });
  assert.deepEqual(result.map(p => p.sku), ["A", "C", "D", "B"]);
});

test("exclude removes the matched product and nothing else", () => {
  const goal = { enabled: true, ruleType: "exclude", skus: ["D"] };
  const result = applyGoalRule({ products: products(), goal });
  assert.deepEqual(result.map(p => p.sku), ["A", "B", "C"]);
});

test("boost/demote never drop or duplicate a product across the whole list", () => {
  const goal = { enabled: true, ruleType: "boost", skus: ["B", "D"] };
  const result = applyGoalRule({ products: products(), goal });
  assert.deepEqual([...result.map(p => p.sku)].sort(), ["A", "B", "C", "D"]);
  assert.equal(result.length, 4);
});

test("exclude on a SKU not present in the list is a no-op", () => {
  const goal = { enabled: true, ruleType: "exclude", skus: ["ZZZ"] };
  const result = applyGoalRule({ products: products(), goal });
  assert.deepEqual(result.map(p => p.sku), ["A", "B", "C", "D"]);
});

test("boost on a SKU not present in the retrieved list has no effect — it cannot inject a product retrieval never surfaced", () => {
  const goal = { enabled: true, ruleType: "boost", skus: ["NOT-IN-LIST"] };
  const result = applyGoalRule({ products: products(), goal });
  assert.deepEqual(result.map(p => p.sku), ["A", "B", "C", "D"]);
});

test("isApplicableGoal rejects an unrecognized ruleType", () => {
  assert.equal(
    isApplicableGoal({ enabled: true, ruleType: "featured", skus: ["A"] }),
    false
  );
});

test("empty products array is returned unchanged", () => {
  const goal = { enabled: true, ruleType: "boost", skus: ["A"] };
  const result = applyGoalRule({ products: [], goal });
  assert.deepEqual(result, []);
});

// =========================================================
// SKU-less products — matched by matchKey (a Shopify Variant ID
// fallback like "variant:gid://shopify/ProductVariant/123" when
// there is no real SKU), never by the empty sku field.
// =========================================================

const productsWithSkuless = () => [
  { sku: "A", matchKey: "A" },
  { sku: "", matchKey: "variant:1" },
  { sku: "", matchKey: "variant:2" },
  { sku: "D", matchKey: "D" }
];

test("boost matches a SKU-less product by matchKey", () => {
  const goal = { enabled: true, ruleType: "boost", skus: ["variant:2"] };
  const result = applyGoalRule({ products: productsWithSkuless(), goal });
  assert.deepEqual(result.map(p => p.matchKey), ["variant:2", "A", "variant:1", "D"]);
});

test("exclude matches a SKU-less product by matchKey, and only that one", () => {
  const goal = { enabled: true, ruleType: "exclude", skus: ["variant:1"] };
  const result = applyGoalRule({ products: productsWithSkuless(), goal });
  assert.deepEqual(result.map(p => p.matchKey), ["A", "variant:2", "D"]);
});

test("demote matches a SKU-less product by matchKey", () => {
  const goal = { enabled: true, ruleType: "demote", skus: ["variant:1"] };
  const result = applyGoalRule({ products: productsWithSkuless(), goal });
  assert.deepEqual(result.map(p => p.matchKey), ["A", "variant:2", "D", "variant:1"]);
});

test("two SKU-less products (both sku: \"\") are never confused with each other", () => {
  const goal = { enabled: true, ruleType: "exclude", skus: ["variant:1"] };
  const result = applyGoalRule({ products: productsWithSkuless(), goal });
  // variant:2 (a different SKU-less product) must survive untouched.
  assert.ok(result.some(p => p.matchKey === "variant:2"));
  assert.ok(!result.some(p => p.matchKey === "variant:1"));
});
