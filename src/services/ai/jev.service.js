// =========================================================
// JEV — FAST RELEVANCE LAYER
// =========================================================
//
// Phase 1 (current): JEV is not a separate model or API call.
// It reuses the semantic similarity scores Qdrant already
// computed during retrieval (via the Qwen embedding model,
// see search.service.js's findSemanticCandidates and
// embedding.service.js) — no new network call, no new latency,
// no new dependency. If a dedicated JEV model/service is
// introduced later, this file is the one place that needs to
// change; nothing else in the app should need to know.
//
// SHADOW MODE (current): this only ever LOGS what it would
// select. It is never allowed to change what actually gets sent
// to GLM — see search.service.js's call site, which always uses
// the full, original candidate list regardless of what JEV says.
// This exists purely so real query behavior can be compared
// against what JEV would have done, before JEV is ever trusted
// to filter anything for real.
//
// Only ever narrows, never guarantees an empty result reaches
// GLM: search.service.js's caller falls back to the full
// candidate list whenever JEV selects nothing, so JEV can never
// be the reason a customer sees "no products found".
// =========================================================

const JEV_RELEVANCE_MIN_SCORE = Number(
  process.env.JEV_RELEVANCE_MIN_SCORE ||
  process.env.SEMANTIC_FALLBACK_MIN_SCORE ||
  "0.30"
);

/*
 * A deliberately stricter bar than JEV_RELEVANCE_MIN_SCORE, used
 * only to decide whether a merchant's Boost rule is allowed to
 * override GLM/rule ranking and force a product into results (see
 * ensureBoostedProductsPresent in search.service.js).
 *
 * JEV's own threshold is intentionally loose — it only decides
 * "is this worth showing GLM as one of several candidates", and
 * JEV is explicitly never a hard gatekeeper. Reusing that same
 * loose bar for "am I confident enough to override ranking and
 * force this specific product to the top" is too permissive:
 * confirmed live, an unrelated boosted product (a coffee mug) for
 * a "red shoes" search cleared JEV_RELEVANCE_MIN_SCORE (0.38 vs
 * 0.30) purely from generic shared e-commerce vocabulary, despite
 * being genuinely irrelevant. Every genuinely relevant match
 * observed in testing scored 0.55+, so this sits in the gap.
 */
const BOOST_RELEVANCE_MIN_SCORE = Number(
  process.env.BOOST_RELEVANCE_MIN_SCORE ||
  "0.50"
);

/*
 * Only candidates that came from semantic retrieval carry a
 * _semanticScore (see findSemanticCandidates) — a candidate
 * found only through MongoDB word-matching has no meaning-based
 * score to judge, so it is treated as "not selected" by JEV
 * rather than guessed at. That is exactly why this stays a
 * narrowing signal alongside lexical search, never a
 * replacement for it — the merge step already keeps both kinds
 * of evidence in the candidate list this function receives.
 */
function getJevSelection(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];

  const selected = list.filter(product => {
    const score = Number(product?._semanticScore);
    return Number.isFinite(score) && score >= JEV_RELEVANCE_MIN_SCORE;
  });

  return {
    selected,
    threshold: JEV_RELEVANCE_MIN_SCORE
  };
}

function logJevShadowSelection({ query, candidates, jevSelection }) {
  const list = Array.isArray(candidates) ? candidates : [];
  const selectedKeys = new Set(jevSelection.selected.map(p => p.matchKey));

  console.log("[JEV SHADOW] selection", {
    query,
    threshold: jevSelection.threshold,
    totalCandidates: list.length,
    jevSelectedCount: jevSelection.selected.length,
    jevSelected: jevSelection.selected.map(p => ({
      sku: p.matchKey,
      title: p.title,
      score: p._semanticScore
    })),
    notSelected: list
      .filter(p => !selectedKeys.has(p.matchKey))
      .map(p => ({
        sku: p.matchKey,
        title: p.title,
        score: Number.isFinite(Number(p?._semanticScore)) ? p._semanticScore : null,
        reason:
          Number.isFinite(Number(p?._semanticScore))
            ? "below threshold"
            : "no semantic score (lexical-only match)"
      }))
  });
}

/*
 * Compares JEV's shadow selection against what GLM actually
 * recommended from the FULL (non-JEV-filtered) candidate list.
 * This is the number that answers "would turning JEV on for
 * real have helped or hurt" — specifically, whether GLM ever
 * picked something JEV would have already discarded.
 */
function logJevVsGlmComparison({ jevSelection, glmRecommendedMatchKeys }) {
  const jevKeys = new Set(jevSelection.selected.map(p => p.matchKey));
  const glmKeys = new Set(
    (glmRecommendedMatchKeys || []).map(key => String(key || "").trim()).filter(Boolean)
  );

  const glmPickedThatJevWouldHaveMissed = [...glmKeys].filter(key => !jevKeys.has(key));
  const jevPickedThatGlmIgnored = [...jevKeys].filter(key => !glmKeys.has(key));

  console.log("[JEV SHADOW] vs GLM comparison", {
    glmRecommendedCount: glmKeys.size,
    jevSelectedCount: jevKeys.size,
    agreementCount: [...glmKeys].filter(key => jevKeys.has(key)).length,
    glmPickedThatJevWouldHaveMissed,
    jevPickedThatGlmIgnored
  });
}

module.exports = {
  JEV_RELEVANCE_MIN_SCORE,
  BOOST_RELEVANCE_MIN_SCORE,
  getJevSelection,
  logJevShadowSelection,
  logJevVsGlmComparison
};
