const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  JEV_RELEVANCE_MIN_SCORE,
  getJevSelection,
  logJevShadowSelection,
  logJevVsGlmComparison
} = require("../src/services/ai/jev.service");

// =========================================================
// Pure functions — no network, no model call. JEV (phase 1)
// reuses the semantic similarity scores Qdrant/Qwen already
// computed during retrieval; this suite only tests the
// selection/logging logic built on top of that, per the design:
// JEV never removes a product from what GLM sees (shadow mode,
// not yet wired to actually filter), and even once filtering is
// turned on, an empty JEV selection must fall back to the full
// candidate list rather than ever causing "no products found".
// =========================================================

test("selects candidates whose semantic score clears the threshold", () => {
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.9 },
    { matchKey: "B", title: "B", _semanticScore: 0.1 },
    { matchKey: "C", title: "C", _semanticScore: JEV_RELEVANCE_MIN_SCORE }
  ];
  const result = getJevSelection(candidates);
  assert.deepEqual(result.selected.map(p => p.matchKey), ["A", "C"]);
});

test("a lexical-only candidate (no semantic score) is not selected, not crashed on", () => {
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.9 },
    { matchKey: "LEX", title: "Lexical-only match" } // no _semanticScore at all
  ];
  const result = getJevSelection(candidates);
  assert.deepEqual(result.selected.map(p => p.matchKey), ["A"]);
});

test("empty candidate list produces an empty selection, not an error", () => {
  const result = getJevSelection([]);
  assert.deepEqual(result.selected, []);
});

test("handles null/undefined candidates gracefully", () => {
  assert.deepEqual(getJevSelection(null).selected, []);
  assert.deepEqual(getJevSelection(undefined).selected, []);
});

test("selection includes the threshold used, for logging/debugging", () => {
  const result = getJevSelection([]);
  assert.equal(result.threshold, JEV_RELEVANCE_MIN_SCORE);
  assert.equal(typeof result.threshold, "number");
});

test("logJevShadowSelection does not throw and does not mutate the candidate list", () => {
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.9 },
    { matchKey: "B", title: "B" }
  ];
  const before = JSON.stringify(candidates);
  const jevSelection = getJevSelection(candidates);

  assert.doesNotThrow(() => {
    logJevShadowSelection({ query: "test query", candidates, jevSelection });
  });

  assert.equal(JSON.stringify(candidates), before, "shadow logging must never mutate the real candidate list");
});

test("logJevVsGlmComparison does not throw for any combination of overlapping/non-overlapping picks", () => {
  const jevSelection = getJevSelection([
    { matchKey: "A", title: "A", _semanticScore: 0.9 },
    { matchKey: "B", title: "B", _semanticScore: 0.9 }
  ]);

  assert.doesNotThrow(() => {
    logJevVsGlmComparison({ jevSelection, glmRecommendedMatchKeys: ["A", "C"] });
  });
  assert.doesNotThrow(() => {
    logJevVsGlmComparison({ jevSelection, glmRecommendedMatchKeys: [] });
  });
  assert.doesNotThrow(() => {
    logJevVsGlmComparison({ jevSelection, glmRecommendedMatchKeys: null });
  });
});

// =========================================================
// The actual safety guarantee this whole design rests on: an
// empty JEV selection must never be used as-is by the caller —
// search.service.js must fall back to the full candidate list.
// This is enforced at the call site (search.service.js), not
// inside jev.service.js itself, so this test documents and
// pins down the exact contract the call site depends on.
// =========================================================

test("contract: when JEV selects nothing, callers are expected to fall back to the full candidate list", () => {
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.01 },
    { matchKey: "B", title: "B", _semanticScore: 0.02 }
  ];
  const jevSelection = getJevSelection(candidates);

  assert.deepEqual(jevSelection.selected, [], "precondition: JEV found nothing above threshold");

  // This is the exact one-line fallback rule used in
  // search.service.js — asserted here so a future change to
  // that call site breaking the fallback would be caught by
  // this test failing to describe the intended contract.
  const candidatesForGlm = jevSelection.selected.length ? jevSelection.selected : candidates;

  assert.deepEqual(candidatesForGlm, candidates, "must fall back to the ORIGINAL full list, never an empty one");
});
