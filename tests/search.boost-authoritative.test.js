const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ensureBoostedProductsPresent } = require("../src/services/search/search.service");
const { applyGoalRule } = require("../src/services/rules/rule-application.service");

// =========================================================
// Pure function — no DB, no network.
//
// Two guarantees this suite locks in:
//
//  1. Boost is authoritative for a RELEVANT product: if GLM's own
//     judgment left a boosted product out of the ranked list (seen
//     live with near-duplicate test products), it still needs to be
//     added back, because applyGoalRule() only ever reorders an
//     existing list, it never adds to it.
//
//  2. Boost is NOT authoritative for an IRRELEVANT product: a
//     boosted coffee mug must never get forced into, or promoted
//     within, a "red shoes" search just because it's on the shop's
//     Boost list somewhere. This has to guard TWO separate paths,
//     confirmed live:
//       a) injecting a MISSING irrelevant product — the original
//          fix.
//       b) promoting an irrelevant product that's already PRESENT
//          in the ranked list for an unrelated reason (in preview
//          mode specifically: it cleared JEV's own loose inclusion
//          threshold on generic vocabulary alone, e.g. 0.38 vs
//          JEV's 0.30, despite being genuinely irrelevant).
//          applyGoalRule()'s boost partition promotes ANY product
//          whose matchKey is in goal.skus, with no relevance check
//          of its own — so ensureBoostedProductsPresent() returns a
//          `goal` with irrelevant boosted SKUs filtered OUT of
//          goal.skus, so applyGoalRule() can never see, and
//          therefore never promote, them.
//
//     Relevance evidence reuses the exact same signal JEV already
//     computes (a semantic score at/above BOOST_RELEVANCE_MIN_SCORE
//     — deliberately stricter than JEV's own threshold, see
//     jev.service.js — or a literal lexical match) — no new
//     model/API call.
//
// ensureBoostedProductsPresent() is called right before
// applyGoalRule() in both preview and final search modes, and its
// returned `goal` (not the caller's original activeGoal) is what
// must be passed to applyGoalRule() from then on. It must be a
// complete no-op (same product/goal references back) outside an
// active Boost rule, so Exclude/Demote/no-rule searches are
// provably unaffected by this file.
// =========================================================

const product = (matchKey, overrides = {}) => ({
  matchKey,
  title: matchKey,
  ...overrides
});

// A candidate as it would appear in semanticCandidates — carries
// _semanticScore, exactly like a real Qdrant-hydrated product.
const semanticEvidence = (matchKey, score) => product(matchKey, { _semanticScore: score });

const RELEVANT_SCORE = 0.75; // well above BOOST_RELEVANCE_MIN_SCORE's default 0.50
const IRRELEVANT_SCORE = 0.38; // the exact real value observed live — clears JEV's 0.30 but not the boost bar

test("adds a RELEVANT boosted product that is missing from the ranked list", () => {
  const products = [product("A"), product("B")];
  const goal = { enabled: true, ruleType: "boost", skus: ["C"] };
  const forcedBoostCandidates = [product("C")];
  const semanticCandidates = [semanticEvidence("C", RELEVANT_SCORE)];

  const { products: result, goal: resultGoal } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates,
    semanticCandidates,
    lexicalCandidates: []
  });

  assert.deepEqual(result.map(p => p.matchKey), ["A", "B", "C"]);
  assert.deepEqual(resultGoal.skus, ["C"]);
});

test("does NOT add a MISSING irrelevant boosted product (the 'coffee mug for red shoes' case)", () => {
  const products = [product("A"), product("B")];
  const goal = { enabled: true, ruleType: "boost", skus: ["MUG"] };
  const forcedBoostCandidates = [product("MUG", { title: "Ceramic Coffee Mug" })];
  const semanticCandidates = [semanticEvidence("MUG", IRRELEVANT_SCORE)];

  const { products: result, goal: resultGoal } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates,
    semanticCandidates,
    lexicalCandidates: []
  });

  assert.deepEqual(result, products);
  assert.ok(!result.some(p => p.matchKey === "MUG"));
  assert.deepEqual(resultGoal.skus, [], "an irrelevant boosted SKU must be filtered out of the goal applyGoalRule sees");
});

test("does NOT let applyGoalRule promote an irrelevant boosted product that is ALREADY present in the list", () => {
  // This is the deeper live bug: the mug wasn't injected — it was
  // already in `products` on its own (e.g. it cleared JEV's loose
  // inclusion threshold in preview mode), and applyGoalRule()'s
  // boost partition would promote it purely because its matchKey
  // is in goal.skus, with no relevance check of its own.
  const products = [
    product("SHOE-1", { recommendationScore: 90 }),
    product("MUG", { recommendationScore: 38 }) // already present, low-ranked
  ];
  const goal = { enabled: true, ruleType: "boost", skus: ["MUG"] };
  const forcedBoostCandidates = [product("MUG")];
  const semanticCandidates = [semanticEvidence("MUG", IRRELEVANT_SCORE)];

  const { products: withBoost, goal: adjustedGoal } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates,
    semanticCandidates,
    lexicalCandidates: []
  });

  const final = applyGoalRule({ products: withBoost, goal: adjustedGoal });

  // MUG must NOT have been promoted to the front — the list order
  // is untouched because applyGoalRule() never saw MUG as a boost
  // target at all (adjustedGoal.skus is empty).
  assert.deepEqual(final.map(p => p.matchKey), ["SHOE-1", "MUG"]);
});

test("does NOT add a boosted product with no relevance evidence at all (never retrieved)", () => {
  const products = [product("A")];
  const goal = { enabled: true, ruleType: "boost", skus: ["MUG"] };
  const forcedBoostCandidates = [product("MUG")];

  const { products: result } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates,
    semanticCandidates: [],
    lexicalCandidates: []
  });

  assert.deepEqual(result, products);
});

test("adds a boosted product with only LEXICAL relevance evidence (no semantic score needed)", () => {
  const products = [product("A")];
  const goal = { enabled: true, ruleType: "boost", skus: ["C"] };
  const forcedBoostCandidates = [product("C")];

  const { products: result } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates,
    semanticCandidates: [],
    lexicalCandidates: [product("C")]
  });

  assert.deepEqual(result.map(p => p.matchKey), ["A", "C"]);
});

test("does not duplicate a boosted product that is already in the ranked list", () => {
  const products = [product("A"), product("C", { recommendationScore: 80 })];
  const goal = { enabled: true, ruleType: "boost", skus: ["C"] };
  const forcedBoostCandidates = [product("C")];

  const { products: result } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates,
    semanticCandidates: [semanticEvidence("C", RELEVANT_SCORE)],
    lexicalCandidates: []
  });

  assert.equal(result.filter(p => p.matchKey === "C").length, 1);
  assert.equal(result.find(p => p.matchKey === "C").recommendationScore, 80);
});

test("injected products get a recognizable recommendationScore/reason", () => {
  const { products: result } = ensureBoostedProductsPresent({
    products: [],
    goal: { enabled: true, ruleType: "boost", skus: ["C"] },
    forcedBoostCandidates: [product("C")],
    semanticCandidates: [semanticEvidence("C", RELEVANT_SCORE)],
    lexicalCandidates: []
  });

  assert.equal(result[0].recommendationScore, 98);
  assert.equal(result[0].recommendationReason, "Boosted by merchant rule");
});

test("combined with applyGoalRule, a relevant injected boosted product ends up first", () => {
  const products = [product("A"), product("B")];
  const goal = { enabled: true, ruleType: "boost", skus: ["C"] };
  const forcedBoostCandidates = [product("C")];

  const { products: withBoost, goal: adjustedGoal } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates,
    semanticCandidates: [semanticEvidence("C", RELEVANT_SCORE)],
    lexicalCandidates: []
  });
  const final = applyGoalRule({ products: withBoost, goal: adjustedGoal });

  assert.deepEqual(final.map(p => p.matchKey), ["C", "A", "B"]);
});

test("no-op (same references back) when there is no goal", () => {
  const products = [product("A")];
  const { products: result, goal: resultGoal } = ensureBoostedProductsPresent({
    products,
    goal: null,
    forcedBoostCandidates: [product("C")],
    semanticCandidates: [semanticEvidence("C", RELEVANT_SCORE)],
    lexicalCandidates: []
  });
  assert.equal(result, products);
  assert.equal(resultGoal, null);
});

test("no-op when the goal is disabled", () => {
  const products = [product("A")];
  const goal = { enabled: false, ruleType: "boost", skus: ["C"] };
  const { products: result, goal: resultGoal } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates: [product("C")],
    semanticCandidates: [semanticEvidence("C", RELEVANT_SCORE)],
    lexicalCandidates: []
  });
  assert.equal(result, products);
  assert.equal(resultGoal, goal);
});

test("no-op for an Exclude rule (goal passed through unchanged, never filtered)", () => {
  const products = [product("A")];
  const goal = { enabled: true, ruleType: "exclude", skus: ["C"] };
  const { products: result, goal: resultGoal } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates: [product("C")],
    semanticCandidates: [semanticEvidence("C", RELEVANT_SCORE)],
    lexicalCandidates: []
  });
  assert.equal(result, products);
  assert.equal(resultGoal, goal, "Exclude's goal.skus must never be touched by this function");
});

test("no-op for a Demote rule (goal passed through unchanged, never filtered)", () => {
  const products = [product("A")];
  const goal = { enabled: true, ruleType: "demote", skus: ["C"] };
  const { products: result, goal: resultGoal } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates: [product("C")],
    semanticCandidates: [semanticEvidence("C", RELEVANT_SCORE)],
    lexicalCandidates: []
  });
  assert.equal(result, products);
  assert.equal(resultGoal, goal, "Demote's goal.skus must never be touched by this function");
});

test("no-op when forcedBoostCandidates is empty (e.g. the boosted product is out of stock), goal still relevance-filtered", () => {
  const products = [product("A")];
  const goal = { enabled: true, ruleType: "boost", skus: ["C"] };
  const { products: result, goal: resultGoal } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates: [],
    semanticCandidates: [semanticEvidence("C", RELEVANT_SCORE)],
    lexicalCandidates: []
  });
  assert.equal(result, products);
  assert.deepEqual(resultGoal.skus, ["C"]);
});

test("handles a missing/undefined products array without throwing", () => {
  const goal = { enabled: true, ruleType: "boost", skus: ["C"] };
  const { products: result } = ensureBoostedProductsPresent({
    products: undefined,
    goal,
    forcedBoostCandidates: [product("C")],
    semanticCandidates: [semanticEvidence("C", RELEVANT_SCORE)],
    lexicalCandidates: []
  });
  assert.deepEqual(result.map(p => p.matchKey), ["C"]);
});

test("adds multiple RELEVANT missing boosted products, all of which then sort to the front together", () => {
  const products = [product("A")];
  const goal = { enabled: true, ruleType: "boost", skus: ["C", "D"] };
  const forcedBoostCandidates = [product("C"), product("D")];

  const { products: withBoost, goal: adjustedGoal } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates,
    semanticCandidates: [semanticEvidence("C", RELEVANT_SCORE), semanticEvidence("D", RELEVANT_SCORE)],
    lexicalCandidates: []
  });
  const final = applyGoalRule({ products: withBoost, goal: adjustedGoal });

  assert.deepEqual(final.map(p => p.matchKey).sort(), ["A", "C", "D"].sort());
  assert.deepEqual(final.slice(0, 2).map(p => p.matchKey).sort(), ["C", "D"]);
  assert.equal(final[2].matchKey, "A");
});

test("mixed relevance: only the relevant one of two boosted products is added or promoted", () => {
  const products = [product("A")];
  const goal = { enabled: true, ruleType: "boost", skus: ["C", "MUG"] };
  const forcedBoostCandidates = [product("C"), product("MUG")];

  const { products: result, goal: adjustedGoal } = ensureBoostedProductsPresent({
    products,
    goal,
    forcedBoostCandidates,
    semanticCandidates: [
      semanticEvidence("C", RELEVANT_SCORE),
      semanticEvidence("MUG", IRRELEVANT_SCORE)
    ],
    lexicalCandidates: []
  });

  assert.deepEqual(result.map(p => p.matchKey).sort(), ["A", "C"]);
  assert.deepEqual(adjustedGoal.skus, ["C"]);
});
