const Goal = require("../../models/Goal");

const Product = require("../../models/Product");


// =========================================================
// GOAL SERVICE
// =========================================================
//
// Every operation in this file is scoped by `shop`.
//
// `shop` is the tenant boundary, so there is intentionally no
// lookup by _id anywhere: a goal is always addressed by the
// shop that owns it.
// =========================================================


// =========================================================
// INDEXES
// =========================================================
//
// The unique index is what actually guarantees one goal per
// shop, so make sure it exists rather than relying on
// Mongoose autoIndex being enabled.
//
// createIndexes() only creates what the schema declares. It
// never drops an existing index (unlike syncIndexes()).
// =========================================================

const ensureGoalIndexes =
  async () => {

    await Goal.createIndexes();


    console.log(
      "[GOAL SERVICE] Goal indexes ensured"
    );
  };


// =========================================================
// NORMALIZATION
// =========================================================

const normalizeShop = (
  value
) =>
  String(
    value || ""
  ).trim();


/*
 * Deduplicate while preserving the merchant's ordering.
 *
 * Order matters: it is the priority the promotion layer will
 * use in a later phase.
 */
const normalizeSkus = (
  values
) => {

  const seen = new Set();

  const skus = [];


  for (
    const value
    of values || []
  ) {

    const sku =
      String(
        value || ""
      ).trim();


    if (
      !sku ||
      seen.has(sku)
    ) {

      continue;
    }


    seen.add(sku);

    skus.push(sku);
  }


  return skus;
};


/*
 * Keep only the display fields the schema declares, and only
 * for SKUs that belong to this shop.
 *
 * This stops a tampered request from storing a foreign
 * product's title/image inside another shop's goal.
 */
const normalizeProducts = (
  values,
  allowedSkus
) => {

  const allowed =
    new Set(allowedSkus);

  const seen = new Set();

  const products = [];


  for (
    const value
    of values || []
  ) {

    const sku =
      String(
        value?.sku || ""
      ).trim();


    if (
      !sku ||
      !allowed.has(sku) ||
      seen.has(sku)
    ) {

      continue;
    }


    seen.add(sku);


    products.push({

      sku,

      shopifyProductId:
        String(
          value?.shopifyProductId || ""
        ).trim(),

      shopifyVariantId:
        String(
          value?.shopifyVariantId || ""
        ).trim(),

      title:
        String(
          value?.title || ""
        ).trim(),

      image:
        String(
          value?.image || ""
        ).trim()

    });
  }


  return products;
};


// =========================================================
// SKU OWNERSHIP
// =========================================================
//
// A goal may only reference products that exist in THIS
// shop's synced catalog.
//
// SKUs are not globally unique, so the shop filter is what
// keeps one merchant from pinning another merchant's product.
// =========================================================

const findUnknownSkus = async ({
  shop,
  skus
}) => {

  if (
    !skus.length
  ) {

    return [];
  }


  const owned =
    await Product.find({

      shop,

      sku: {
        $in: skus
      }

    })

      .select("sku")

      .lean();


  const ownedSkus =
    new Set(
      owned.map(
        product => product.sku
      )
    );


  return skus.filter(
    sku =>
      !ownedSkus.has(sku)
  );
};


// =========================================================
// READ
// =========================================================

const getGoal = async (
  shop
) =>
  Goal.findOne({
    shop:
      normalizeShop(shop)
  }).lean();


/*
 * The goal the search layer will eventually promote.
 *
 * A disabled goal, or a goal with no usable SKUs, is treated
 * as "no active goal" so the caller never has to special-case
 * it.
 *
 * NOT wired into search.service.js yet. That is Phase 3.
 */
const getActiveGoal = async (
  shop
) => {

  const goal =
    await getGoal(shop);


  if (
    !goal ||
    goal.enabled !== true ||
    !Array.isArray(goal.skus) ||
    !goal.skus.length
  ) {

    return null;
  }


  return goal;
};


// =========================================================
// CREATE / UPDATE
// =========================================================
//
// One upsert covers both cases. Separate create/update paths
// would reintroduce the double-goal race the unique index
// exists to prevent.
// =========================================================

const upsertGoal = async ({
  shop,
  name,
  skus,
  products,
  enabled
}) => {

  const update = {

    shop,

    name,

    skus,

    products

  };


  /*
   * Leave `enabled` alone when the caller did not send it:
   * on insert the schema default applies, on update the
   * merchant's existing choice is preserved.
   */
  if (
    enabled !== undefined
  ) {

    update.enabled =
      Boolean(enabled);
  }


  return Goal.findOneAndUpdate(

    {
      shop
    },

    {
      $set: update
    },

    {
      upsert: true,

      new: true,

      setDefaultsOnInsert: true,

      runValidators: true
    }

  ).lean();
};


// =========================================================
// DELETE
// =========================================================

const deleteGoal = async (
  shop
) => {

  const result =
    await Goal.deleteOne({
      shop:
        normalizeShop(shop)
    });


  return (
    result?.deletedCount || 0
  ) > 0;
};


module.exports = {
  ensureGoalIndexes,
  normalizeShop,
  normalizeSkus,
  normalizeProducts,
  findUnknownSkus,
  getGoal,
  getActiveGoal,
  upsertGoal,
  deleteGoal
};
