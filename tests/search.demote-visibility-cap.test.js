const { test } = require("node:test");
const assert = require("node:assert/strict");

const { applyDemoteVisibilityCap } = require("../src/services/search/search.service");
const { applyGoalRule } = require("../src/services/rules/rule-application.service");

// =========================================================
// Pure function — no DB, no network.
//
// This is the fix for: preview search caps results at 6 items,
// and applies rules BEFORE that cap. Boost and Exclude need that
// order (Boost must be able to pull a product INTO the visible
// 6; Exclude's removal must let the next-best product take its
// place) — both already worked correctly and are NOT touched by
// this fix. Demote is different: moving a product to the very
// end before the cap runs could push it completely off the
// visible list instead of just "last" — this is exactly what
// the user reported and what this suite proves is now fixed,
// while confirming boost/exclude behave identically to before.
// =========================================================

const products = (n) =>
  Array.from({ length: n }, (_, i) => ({ matchKey: String.fromCharCode(65 + i) })); // A, B, C, ...

test("demote: a demoted product naturally within the top 6 still appears, appended after the cap", () => {
  const natural = products(7); // A..G
  const goal = { enabled: true, ruleType: "demote", skus: ["C"] }; // C was naturally 3rd
  const ruleApplied = applyGoalRule({ products: natural, goal });

  const result = applyDemoteVisibilityCap({
    naturalRankedProducts: natural,
    ruleAppliedProducts: ruleApplied,
    goal,
    limit: 6
  });

  assert.deepEqual(
    result.map(p => p.matchKey),
    ["A", "B", "D", "E", "F", "G", "C"],
    "C must still appear, at the very end, not disappear"
  );
});

test("demote: a demoted product that was never naturally in the top N is correctly still absent", () => {
  const natural = products(8); // A..H
  const goal = { enabled: true, ruleType: "demote", skus: ["H"] }; // H was naturally 8th, already outside top 6
  const ruleApplied = applyGoalRule({ products: natural, goal });

  const result = applyDemoteVisibilityCap({
    naturalRankedProducts: natural,
    ruleAppliedProducts: ruleApplied,
    goal,
    limit: 6
  });

  assert.deepEqual(result.map(p => p.matchKey), ["A", "B", "C", "D", "E", "F"]);
  assert.ok(!result.some(p => p.matchKey === "H"));
});

test("demote: with 6 or fewer candidates total, nothing changes (no cap was ever hit)", () => {
  const natural = products(5); // A..E
  const goal = { enabled: true, ruleType: "demote", skus: ["B"] };
  const ruleApplied = applyGoalRule({ products: natural, goal });

  const result = applyDemoteVisibilityCap({
    naturalRankedProducts: natural,
    ruleAppliedProducts: ruleApplied,
    goal,
    limit: 6
  });

  assert.deepEqual(result.map(p => p.matchKey), ["A", "C", "D", "E", "B"]);
});

test("demote: multiple demoted products naturally in the top 6 are all restored, in their relative order", () => {
  const natural = products(8); // A..H
  const goal = { enabled: true, ruleType: "demote", skus: ["B", "E"] }; // both naturally within top 6
  const ruleApplied = applyGoalRule({ products: natural, goal });

  const result = applyDemoteVisibilityCap({
    naturalRankedProducts: natural,
    ruleAppliedProducts: ruleApplied,
    goal,
    limit: 6
  });

  assert.deepEqual(
    result.map(p => p.matchKey),
    ["A", "C", "D", "F", "G", "H", "B", "E"]
  );
});

// =========================================================
// Boost and Exclude must behave EXACTLY as before — this
// function must be a pure pass-through (just the plain cap) for
// both, since the fix must never touch them.
// =========================================================

test("boost: unaffected — behaves as a plain cap, identical to before this fix", () => {
  const natural = products(8);
  const goal = { enabled: true, ruleType: "boost", skus: ["H"] }; // H was naturally last, boost pulls it to the front
  const ruleApplied = applyGoalRule({ products: natural, goal });

  const result = applyDemoteVisibilityCap({
    naturalRankedProducts: natural,
    ruleAppliedProducts: ruleApplied,
    goal,
    limit: 6
  });

  assert.deepEqual(result, ruleApplied.slice(0, 6));
  assert.deepEqual(result.map(p => p.matchKey), ["H", "A", "B", "C", "D", "E"]);
});

test("exclude: unaffected — behaves as a plain cap, identical to before this fix", () => {
  const natural = products(8);
  const goal = { enabled: true, ruleType: "exclude", skus: ["B"] }; // B removed, G naturally takes the 6th slot
  const ruleApplied = applyGoalRule({ products: natural, goal });

  const result = applyDemoteVisibilityCap({
    naturalRankedProducts: natural,
    ruleAppliedProducts: ruleApplied,
    goal,
    limit: 6
  });

  assert.deepEqual(result, ruleApplied.slice(0, 6));
  assert.deepEqual(result.map(p => p.matchKey), ["A", "C", "D", "E", "F", "G"]);
});

test("no active goal: unaffected — plain cap", () => {
  const natural = products(8);
  const ruleApplied = applyGoalRule({ products: natural, goal: null });

  const result = applyDemoteVisibilityCap({
    naturalRankedProducts: natural,
    ruleAppliedProducts: ruleApplied,
    goal: null,
    limit: 6
  });

  assert.deepEqual(result.map(p => p.matchKey), ["A", "B", "C", "D", "E", "F"]);
});

test("demote: works correctly for a SKU-less demoted product too", () => {
  const natural = [
    { matchKey: "A" },
    { matchKey: "variant:skuless-1" },
    { matchKey: "C" },
    { matchKey: "D" },
    { matchKey: "E" },
    { matchKey: "F" },
    { matchKey: "G" }
  ];
  const goal = { enabled: true, ruleType: "demote", skus: ["variant:skuless-1"] };
  const ruleApplied = applyGoalRule({ products: natural, goal });

  const result = applyDemoteVisibilityCap({
    naturalRankedProducts: natural,
    ruleAppliedProducts: ruleApplied,
    goal,
    limit: 6
  });

  assert.deepEqual(
    result.map(p => p.matchKey),
    ["A", "C", "D", "E", "F", "G", "variant:skuless-1"]
  );
});
