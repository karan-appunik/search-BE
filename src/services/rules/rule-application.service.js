// =========================================================
// GOAL RULE APPLICATION
// =========================================================
//
// Pure, synchronous, dependency-free reordering/filtering of an
// already-ranked product list. This file makes NO database
// calls and NO network calls — the caller fetches the active
// goal once (see goal.service.js's getActiveGoal) and passes
// it in.
//
// This runs strictly AFTER retrieval (MongoDB lexical + Qdrant
// semantic), AFTER merging/deduplication, and AFTER GLM ranking
// has already produced the caller's ranked/verified product
// list. It never re-ranks by lexical/semantic score itself and
// never talks to Qdrant, Mongo, or the LLM — it only reorders
// or filters the list GLM (or the existing fallback paths) has
// already decided on.
//
// Kept separate from search.service.js specifically so it can
// be unit tested with plain arrays, without a database or an
// LLM call in the loop.
// =========================================================

const RULE_TYPES = ["boost", "exclude", "demote"];

/*
 * True when a goal is a real, currently-active rule this
 * function should act on. Mirrors goal.service.js's
 * getActiveGoal semantics (enabled + non-empty skus), plus a
 * ruleType check specific to rule application: a goal can
 * legitimately exist with no ruleType chosen yet (a seller's
 * in-progress draft), and that must be a no-op here, not an
 * error.
 */
function isApplicableGoal(goal) {
  if (!goal || goal.enabled !== true) {
    return false;
  }

  if (!Array.isArray(goal.skus) || goal.skus.length === 0) {
    return false;
  }

  return RULE_TYPES.includes(goal.ruleType);
}

/*
 * Stable partition: every input item lands in exactly one of
 * the two output arrays, and the relative order WITHIN each
 * array is preserved exactly as it was in the input. This is
 * what "boost"/"demote" actually are — a reordering of the
 * existing ranked list, not a new ranking, and it cannot
 * duplicate or drop an item since each item is visited exactly
 * once.
 */
function stablePartition(products, matches) {
  const matched = [];
  const unmatched = [];

  for (const product of products) {
    if (matches(product)) {
      matched.push(product);
    } else {
      unmatched.push(product);
    }
  }

  return { matched, unmatched };
}

/*
 * Applies the shop's active goal/rule to an already-ranked,
 * already-verified, already-available product list.
 *
 * Safe no-ops (returns `products` unchanged, same array
 * reference, no allocation) when:
 *   - there is no goal, it is disabled, or has no SKUs
 *   - the goal's ruleType is null/undefined/unrecognized
 *     (a saved goal with no rule type chosen yet)
 *   - `products` is not a non-empty array
 *
 * `boost`/`demote` never remove or duplicate a product — every
 * product in `products` appears exactly once in the result,
 * in one of two stable-ordered groups. `exclude` only ever
 * removes; it never re-adds anything from anywhere else (there
 * is nothing here that reaches back into retrieval/fallback
 * data, so an excluded SKU cannot be reintroduced by this
 * function no matter which upstream fallback produced
 * `products`).
 */
function applyGoalRule({ products, goal }) {
  if (!Array.isArray(products) || products.length === 0) {
    return products;
  }

  if (!isApplicableGoal(goal)) {
    return products;
  }

  /*
   * goal.skus holds each target product's matchKey (its real SKU
   * when it has one, otherwise its Shopify Variant ID — see
   * Product.js) — the field name is unchanged from before this
   * app supported SKU-less products, to avoid touching the
   * Goal schema/API shape, but the values it stores are matchKeys.
   * Matching against product.matchKey (never product.sku
   * directly) is what lets a rule target a SKU-less product.
   */
  const targetKeySet = new Set(goal.skus);

  if (goal.ruleType === "exclude") {
    return products.filter((product) => !targetKeySet.has(product?.matchKey));
  }

  if (goal.ruleType === "boost") {
    const { matched, unmatched } = stablePartition(products, (p) => targetKeySet.has(p?.matchKey));
    return [...matched, ...unmatched];
  }

  if (goal.ruleType === "demote") {
    const { matched, unmatched } = stablePartition(products, (p) => targetKeySet.has(p?.matchKey));
    return [...unmatched, ...matched];
  }

  // Unreachable given isApplicableGoal's RULE_TYPES check, but
  // fail safe rather than throw on unexpected stored data.
  return products;
}

module.exports = {
  RULE_TYPES,
  isApplicableGoal,
  applyGoalRule
};
