const { test } = require("node:test");
const assert = require("node:assert/strict");

const { rankPreviewCandidatesWithoutGlm } = require("../src/services/search/search.service");

// =========================================================
// Pure function — no DB, no network, no GLM call.
//
// PERFORMANCE FIX: preview (predictive/typing) search no longer
// calls GLM at all — that cloud round-trip was the ~1-1.5s
// bottleneck. This is what ranks preview results now, using only
// the semantic scores (Qdrant/Qwen) and lexical matches (MongoDB)
// already computed during retrieval — the exact same signal JEV
// itself uses, so "using existing JEV/Qdrant setup" is literal
// here, not just a description.
//
// Critical guarantee this suite locks in: a candidate present ONLY
// because it was force-merged as a boosted product (no semantic
// score, no lexical match) must be excluded from this ranking —
// otherwise an irrelevant boosted product would look exactly like
// a "no score = lexical match" candidate and get ranked to the
// top by mistake. ensureBoostedProductsPresent (tested separately
// in search.boost-authoritative.test.js) is the only place that
// decides an irrelevant/relevant boosted product's fate.
// =========================================================

const semantic = (matchKey, score, overrides = {}) => ({
  matchKey,
  title: matchKey,
  _semanticScore: score,
  ...overrides
});

const lexicalOnly = (matchKey, overrides = {}) => ({
  matchKey,
  title: matchKey,
  ...overrides
});

test("ranks semantic candidates by score, highest first", () => {
  const candidates = [semantic("LOW", 0.3), semantic("HIGH", 0.9), semantic("MID", 0.6)];

  const { products } = rankPreviewCandidatesWithoutGlm({
    query: "test",
    candidates,
    lexicalCandidates: []
  });

  assert.deepEqual(products.map(p => p.matchKey), ["HIGH", "MID", "LOW"]);
});

test("lexical matches are ranked ahead of semantic-only matches", () => {
  const candidates = [semantic("SEM", 0.95), lexicalOnly("LEX")];

  const { products } = rankPreviewCandidatesWithoutGlm({
    query: "test",
    candidates,
    lexicalCandidates: [lexicalOnly("LEX")]
  });

  assert.deepEqual(products.map(p => p.matchKey), ["LEX", "SEM"]);
});

test("excludes a candidate with no semantic score AND no lexical evidence (e.g. a force-merged boosted product)", () => {
  const candidates = [semantic("REAL", 0.7), lexicalOnly("GHOST")];

  const { products } = rankPreviewCandidatesWithoutGlm({
    query: "test",
    // GHOST is in `candidates` (as candidatesForGlm would contain
    // it via a forced-boost merge) but NOT in lexicalCandidates —
    // no organic evidence it's relevant to this query.
    candidates,
    lexicalCandidates: []
  });

  assert.deepEqual(products.map(p => p.matchKey), ["REAL"]);
});

test("empty candidate list produces empty products, not an error", () => {
  const { products, resultType } = rankPreviewCandidatesWithoutGlm({
    query: "test",
    candidates: [],
    lexicalCandidates: []
  });

  assert.deepEqual(products, []);
  assert.equal(resultType, "recommended");
});

test("resultType is 'direct' when a candidate has strong title-word overlap with the query", () => {
  const candidates = [semantic("SHOE", 0.8, { title: "Red Running Shoe" })];

  const { resultType } = rankPreviewCandidatesWithoutGlm({
    query: "red running shoe",
    candidates,
    lexicalCandidates: []
  });

  assert.equal(resultType, "direct");
});

test("resultType is 'recommended' for a genuinely relevant but non-literal (need-based) match", () => {
  const candidates = [semantic("CLEANSER", 0.65, { title: "Gentle Hydrating Face Wash" })];

  const { resultType } = rankPreviewCandidatesWithoutGlm({
    query: "good cleanser for dry skin",
    candidates,
    lexicalCandidates: []
  });

  // No literal word overlap between the query and the title, but
  // it still cleared retrieval/JEV, so it's a normal relevant
  // result, not a fallback — never "alternative".
  assert.equal(resultType, "recommended");
  assert.notEqual(resultType, "alternative");
});

test("never produces resultType 'alternative' (only a normal 'direct' or 'recommended' result)", () => {
  const candidates = [semantic("A", 0.05), lexicalOnly("B")];

  const { resultType } = rankPreviewCandidatesWithoutGlm({
    query: "anything",
    candidates,
    lexicalCandidates: [lexicalOnly("B")]
  });

  assert.ok(resultType === "direct" || resultType === "recommended");
});

test("assigns a recognizable recommendationScore/reason to lexical vs semantic products", () => {
  const candidates = [semantic("SEM", 0.5), lexicalOnly("LEX")];

  const { products } = rankPreviewCandidatesWithoutGlm({
    query: "test",
    candidates,
    lexicalCandidates: [lexicalOnly("LEX")]
  });

  const lex = products.find(p => p.matchKey === "LEX");
  const sem = products.find(p => p.matchKey === "SEM");

  assert.equal(lex.recommendationScore, 90);
  assert.equal(lex.recommendationReason, "Matches your search");
  assert.equal(sem.recommendationScore, 50);
  assert.equal(sem.recommendationReason, "Relevant catalog match");
});

test("recommendationScore is clamped to at most 98", () => {
  const candidates = [semantic("PERFECT", 1.5)]; // defensively over 1.0
  const { products } = rankPreviewCandidatesWithoutGlm({
    query: "test",
    candidates,
    lexicalCandidates: []
  });

  assert.equal(products[0].recommendationScore, 98);
});

test("handles undefined candidates/lexicalCandidates without throwing", () => {
  const { products, resultType } = rankPreviewCandidatesWithoutGlm({
    query: "test",
    candidates: undefined,
    lexicalCandidates: undefined
  });

  assert.deepEqual(products, []);
  assert.equal(resultType, "recommended");
});
