const Product = require("../models/Product");

// =========================================================
// PRODUCT REPOSITORY
// =========================================================
//
// All Mongoose access to the Product collection for the
// Goal / status / dashboard code paths lives here. This does
// NOT include search.service.js — its retrieval queries
// (lexical prefix/text search, semantic hydration) are
// intentionally left untouched and still call the Product
// model directly, per the explicit instruction not to
// restructure the existing search system.
//
// Every method here is shop-scoped except the couple of
// explicitly-named "AllShops" aggregates used by the
// developer dashboard's global overview.
// =========================================================

const PICKER_FIELDS = [
  "sku",
  "matchKey",
  "title",
  "handle",
  "image",
  "price",
  "availableForSale",
  "inventoryQuantity",
  "shopifyProductId",
  "shopifyVariantId",
  "createdAt",
  "updatedAt"
].join(" ");

/*
 * Products belonging to a shop, matching an optional search
 * term against title/sku/handle, paginated.
 */
async function findByShop({
  shop,
  filter = {},
  select = PICKER_FIELDS,
  skip = 0,
  limit = 25,
  sort = { title: 1, sku: 1, _id: 1 }
}) {
  return Product.find({ shop, ...filter })
    .select(select)
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .lean();
}

async function countByShop({ shop, filter = {} }) {
  return Product.countDocuments({ shop, ...filter });
}

/*
 * Full-document lookup by an exact set of matchKeys (a real SKU
 * when a product has one, otherwise its Shopify Variant ID — see
 * Product.js), scoped to a single shop. Used for ownership
 * validation when a goal is saved, and for hydrating a saved
 * goal's product snapshot. The parameter is still named `skus`
 * since that is the shape callers already pass (goal.skus), but
 * the values are matchKeys.
 */
async function findByShopAndSkus({ shop, skus, fields }) {
  if (!Array.isArray(skus) || !skus.length) {
    return [];
  }

  const query = Product.find({ shop, matchKey: { $in: skus } });

  if (fields) {
    query.select(fields);
  } else {
    query.select(PICKER_FIELDS);
  }

  return query.lean();
}

/*
 * Availability breakdown for a single shop — used by the
 * seller Dashboard tab and the developer Overview/System
 * Health sections. availableForSale is Shopify's own computed
 * "can this be purchased right now" flag (see
 * search.service.js for the same reasoning), so this reports
 * real stock status, not an invented threshold.
 */
/*
 * Best real proxy for "last synced at" without a dedicated
 * sync-log table: products are upserted during every sync run,
 * so the most recent updatedAt across a shop's products is the
 * most recent moment a sync touched this shop. Returns null
 * when the shop has no products yet — never an invented date.
 */
async function getLastSyncedAt(shop) {
  const latest = await Product.findOne({ shop })
    .select("updatedAt")
    .sort({ updatedAt: -1 })
    .lean();

  return latest?.updatedAt || null;
}

async function countAvailabilityByShop(shop) {
  const [total, available] = await Promise.all([
    Product.countDocuments({ shop }),
    Product.countDocuments({ shop, availableForSale: true })
  ]);

  return {
    total,
    available,
    unavailable: total - available
  };
}

/*
 * Every shop that has synced products, with a product count
 * each. Used only by the developer dashboard to let the app
 * creator pick a shop to inspect — it never returns product or
 * goal payloads itself, just identifiers + counts, so it does
 * not bypass the shop-scoped access pattern used everywhere
 * else.
 */
async function distinctShopsWithCounts() {
  return Product.aggregate([
    { $group: { _id: "$shop", productCount: { $sum: 1 } } },
    { $project: { _id: 0, shop: "$_id", productCount: 1 } },
    { $sort: { shop: 1 } }
  ]);
}

async function countAllShops() {
  const [total, available] = await Promise.all([
    Product.countDocuments({}),
    Product.countDocuments({ availableForSale: true })
  ]);

  return {
    total,
    available,
    unavailable: total - available
  };
}

module.exports = {
  findByShop,
  countByShop,
  findByShopAndSkus,
  getLastSyncedAt,
  countAvailabilityByShop,
  distinctShopsWithCounts,
  countAllShops
};
