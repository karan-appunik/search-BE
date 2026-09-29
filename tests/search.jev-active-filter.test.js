const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveJevCandidatesForGlm } = require("../src/services/search/search.service");

// =========================================================
// Pure function — no DB, no network.
//
// This is JEV's actual filtering decision, shared by both preview
// and final/submitted search: narrow what GLM sees down to
// candidates whose existing Qdrant/Qwen semantic score clears a
// relevance bar. Three guarantees this suite locks in, per
// explicit design requirements:
//
//  1. JEV must never be a hard gatekeeper — if it selects nothing,
//     GLM must still get the FULL original candidate list, never
//     an empty one (no "no products found" regression).
//  2. Boost must keep working exactly as before — a forced-boost
//     candidate never carries a _semanticScore (it's a merchant
//     rule, not a retrieval result), so JEV's relevance filter
//     must never be allowed to silently drop it.
//  3. A literal/exact keyword match found only by MongoDB's
//     lexical search (no _semanticScore at all, because it never
//     came through Qdrant) must never be dropped either — JEV only
//     narrows candidates it actually scored and judged irrelevant,
//     never one it has no opinion on.
// =========================================================

test("narrows to only the candidates that clear JEV's relevance threshold", () => {
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.9 },
    { matchKey: "B", title: "B", _semanticScore: 0.05 },
    { matchKey: "C", title: "C", _semanticScore: 0.8 }
  ];

  const { candidatesForGlm } = resolveJevCandidatesForGlm({
    candidates,
    forcedBoostCandidates: []
  });

  assert.deepEqual(
    candidatesForGlm.map(p => p.matchKey).sort(),
    ["A", "C"]
  );
});

test("falls back to the FULL original candidate list when JEV selects nothing", () => {
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.01 },
    { matchKey: "B", title: "B", _semanticScore: 0.02 }
  ];

  const { candidatesForGlm } = resolveJevCandidatesForGlm({
    candidates,
    forcedBoostCandidates: []
  });

  assert.deepEqual(candidatesForGlm, candidates);
});

test("a forced-boost candidate always survives JEV's filter, even with no semantic score", () => {
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.9 } // clears threshold, JEV selects something
  ];
  const forcedBoostCandidates = [
    { matchKey: "BOOSTED", title: "Boosted product" } // no _semanticScore at all
  ];

  const { candidatesForGlm } = resolveJevCandidatesForGlm({
    candidates,
    forcedBoostCandidates
  });

  const keys = candidatesForGlm.map(p => p.matchKey);
  assert.ok(keys.includes("A"), "JEV-selected candidate must still be present");
  assert.ok(keys.includes("BOOSTED"), "forced-boost candidate must never be dropped by JEV");
});

test("a forced-boost candidate is included even when JEV selects nothing (full-list fallback already contains it via mergeCandidates upstream)", () => {
  // When JEV selects nothing, resolveJevCandidatesForGlm falls back
  // to the raw `candidates` array as-is. In the real pipeline,
  // forced-boost candidates are already merged into `candidates`
  // upstream (see the preview branch in search.service.js), so
  // this documents that resolveJevCandidatesForGlm does not need
  // to re-merge them again on the fallback path.
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.01 },
    { matchKey: "BOOSTED", title: "Boosted product" } // already merged in upstream
  ];

  const { candidatesForGlm } = resolveJevCandidatesForGlm({
    candidates,
    forcedBoostCandidates: [{ matchKey: "BOOSTED", title: "Boosted product" }]
  });

  assert.deepEqual(candidatesForGlm, candidates);
});

test("a lexical-only candidate (no semantic score at all) always survives JEV's filter", () => {
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.9 }, // clears threshold, JEV selects something
    { matchKey: "LEX", title: "Exact keyword match" } // no _semanticScore — lexical-only
  ];

  const { candidatesForGlm } = resolveJevCandidatesForGlm({
    candidates,
    forcedBoostCandidates: []
  });

  const keys = candidatesForGlm.map(p => p.matchKey);
  assert.ok(keys.includes("A"), "JEV-selected candidate must still be present");
  assert.ok(keys.includes("LEX"), "a candidate JEV never scored must never be dropped by JEV");
});

test("a lexical-only candidate is dropped only if JEV actually scored it below threshold, not merely because it's lexical-adjacent", () => {
  // A candidate that DOES have a low semantic score (JEV looked at
  // it and judged it irrelevant) is correctly excluded — this is
  // different from having NO score at all.
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.9 },
    { matchKey: "LOW", title: "Weakly related", _semanticScore: 0.02 }
  ];

  const { candidatesForGlm } = resolveJevCandidatesForGlm({
    candidates,
    forcedBoostCandidates: []
  });

  assert.deepEqual(candidatesForGlm.map(p => p.matchKey), ["A"]);
});

test("does not duplicate a candidate that is both JEV-selected and a forced-boost candidate", () => {
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.9 }
  ];
  const forcedBoostCandidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.9 }
  ];

  const { candidatesForGlm } = resolveJevCandidatesForGlm({
    candidates,
    forcedBoostCandidates
  });

  assert.equal(candidatesForGlm.filter(p => p.matchKey === "A").length, 1);
});

test("returns the jevSelection alongside candidatesForGlm, for shadow logging to still work", () => {
  const candidates = [
    { matchKey: "A", title: "A", _semanticScore: 0.9 }
  ];

  const { jevSelection } = resolveJevCandidatesForGlm({
    candidates,
    forcedBoostCandidates: []
  });

  assert.deepEqual(jevSelection.selected.map(p => p.matchKey), ["A"]);
  assert.equal(typeof jevSelection.threshold, "number");
});

test("handles no forced-boost candidates (undefined) without throwing", () => {
  const candidates = [{ matchKey: "A", title: "A", _semanticScore: 0.9 }];

  assert.doesNotThrow(() => {
    resolveJevCandidatesForGlm({ candidates, forcedBoostCandidates: undefined });
  });
});
