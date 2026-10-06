// =========================================================
// JEV — FAST RELEVANCE LAYER
// =========================================================
//
// Phase 1 (current): JEV is not a separate model or API call.
// It reuses the semantic similarity scores vector search already
// computed during retrieval (via the Qwen embedding model,
// see search.service.js's findSemanticCandidates and
// embedding.service.js) — no new network call, no new latency,
// no new dependency. If a dedicated JEV model/service is
// introduced later, this file is the one place that needs to
// change; nothing else in the app should need to know.
//
// ACTIVE (no longer shadow mode). JEV's scores are used in
// search.service.js to:
//   - rank the instant results shown while the customer types;
//   - drop candidates below JEV_RELEVANCE_MIN_SCORE before the
//     AI model sees them (resolveJevCandidatesForGlm);
//   - answer the search when the AI model fails ("JEV MODEL
//     RESPONSE": usage limit, token limit, invalid answer, error);
//   - decide whether a Boost rule may promote a product
//     (BOOST_RELEVANCE_MIN_SCORE);
//   - pick the in-stock alternatives for "We didn't find
//     exactly that...".
//
// Only ever narrows, never empties: search.service.js falls back
// to the full candidate list whenever JEV selects nothing, so JEV
// can never be the reason a customer sees "no products found".
//
// Logging: "[JEV]" summarises each selection, and "[JEV vs AI]"
// compares what JEV would have shown with what the AI picked —
// real-traffic evidence of how good JEV's instant and fallback
// results are.
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

  // One-line summary: counts plus the 5 highest-scoring selected
  // (sorted on a copy; the real list is never reordered).
  const notSelected = list.filter(p => !selectedKeys.has(p.matchKey));

  const top = [...jevSelection.selected]
    .sort((a, b) => Number(b?._semanticScore) - Number(a?._semanticScore))
    .slice(0, 5)
    .map(p => `${p.title} (${Number(p._semanticScore).toFixed(2)})`)
    .join(", ");

  console.log(
    `[JEV] "${query}": ${jevSelection.selected.length}/${list.length} selected (threshold ${jevSelection.threshold})` +
    `, ${notSelected.length} not selected` +
    (top ? ` | top: ${top}` : "")
  );
}

/*
 * Compares what JEV would have shown for a search with what the AI
 * actually picked, after a successful AI answer. One line per
 * search; pure in-memory work (no I/O), so it never slows search.
 *
 *   jevRankedKeys            JEV's own ranking for the search
 *                            (best first), as matchKeys
 *   glmRecommendedMatchKeys  the AI's picks, as matchKeys
 *   titles                   optional matchKey -> title map for
 *                            readable logs
 *
 * JEV is compared over the same number of products the AI chose.
 * Without jevRankedKeys it compares against JEV's selection.
 */
function logJevVsGlmComparison({
  query = "",
  jevSelection,
  jevRankedKeys,
  glmRecommendedMatchKeys,
  titles
}) {
  const aiKeys = [
    ...new Set(
      (glmRecommendedMatchKeys || []).map(key => String(key || "").trim()).filter(Boolean)
    )
  ];

  if (!aiKeys.length) {
    return;
  }

  const jevKeys = Array.isArray(jevRankedKeys)
    ? jevRankedKeys.slice(0, aiKeys.length)
    : (jevSelection?.selected || []).map(p => p.matchKey);

  const jevSet = new Set(jevKeys);
  const aiSet = new Set(aiKeys);

  const same = aiKeys.filter(key => jevSet.has(key)).length;
  const name = key => (titles && titles.get(key)) || key;
  const aiOnly = aiKeys.filter(key => !jevSet.has(key)).map(name);
  const jevOnly = jevKeys.filter(key => !aiSet.has(key)).map(name);

  console.log(
    `[JEV vs AI] "${query}": ${same}/${aiKeys.length} same (${Math.round((same / aiKeys.length) * 100)}%)` +
    (aiOnly.length ? ` | AI only: ${aiOnly.join(", ")}` : "") +
    (jevOnly.length ? ` | JEV only: ${jevOnly.join(", ")}` : "")
  );
}

module.exports = {
  JEV_RELEVANCE_MIN_SCORE,
  BOOST_RELEVANCE_MIN_SCORE,
  getJevSelection,
  logJevShadowSelection,
  logJevVsGlmComparison
};
