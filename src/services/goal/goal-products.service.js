const Product = require("../../models/Product");


// =========================================================
// GOAL PRODUCT LISTING
// =========================================================
//
// Read-only, shop-scoped product listing for the admin Goal
// picker UI.
//
// This is intentionally separate from the product-sync
// pipeline (internal-product.controller.js) and from AI
// search retrieval (search.service.js): it exists purely so
// the admin can browse/search the already-synced catalog to
// choose products for a goal. It does not rank, does not call
// the AI/vector stack, and does not write anything.
// =========================================================


const DEFAULT_LIMIT = 25;

const MAX_LIMIT = 100;


// =========================================================
// FIELDS RETURNED TO THE ADMIN UI
// =========================================================
//
// Kept minimal on purpose. The full Product document carries
// AI/search-only fields (embeddingText, tags, ingredients,
// etc.) that the picker UI has no use for.
// =========================================================

const LIST_FIELDS =
  [
    "-_id",
    "sku",
    "matchKey",
    "title",
    "handle",
    "image",
    "price",
    "currency",
    "availableForSale",
    "inventoryQuantity",
    "productType",
    "shopifyProductId",
    "shopifyVariantId"
  ].join(" ");


/*
 * Same escaping used by the existing lexical retrieval code
 * in search.service.js (findPrefixCandidates / findPartialCandidates).
 * Duplicated locally rather than importing from that file, since
 * that file is not to be modified or depended on for this phase.
 */
function escapeRegex(value) {

  return String(
    value || ""
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}


function clampInt(
  value,
  {
    fallback,
    min,
    max
  }
) {

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {

    return {
      value: fallback,
      valid: true
    };
  }


  const parsed =
    Number(value);


  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed)
  ) {

    return {
      value: fallback,
      valid: false
    };
  }


  return {
    value:
      Math.min(
        max,
        Math.max(
          min,
          parsed
        )
      ),
    valid: true
  };
}


// =========================================================
// LIST PRODUCTS FOR GOAL SELECTION
// =========================================================
//
// Shop-scoped, paginated, optionally filtered by a search term
// matched against title, sku, or handle.
//
// Uses a "fetch limit + 1" trick to determine hasMore instead
// of a separate countDocuments() call, so a search-heavy admin
// session does not run every query twice.
// =========================================================

/*
 * Optional sort orders for the admin picker. "title_asc" is
 * the original order and the default. Every order ends with
 * the same tiebreakers so pagination stays stable.
 */
const SORTS = {
  title_asc: { title: 1, sku: 1, _id: 1 },
  title_desc: { title: -1, sku: 1, _id: 1 },
  price_asc: { price: 1, title: 1, sku: 1, _id: 1 },
  price_desc: { price: -1, title: 1, sku: 1, _id: 1 }
};

const DEFAULT_SORT = "title_asc";

function normalizeSort(value) {

  const key =
    String(value || "").trim();

  return Object.prototype.hasOwnProperty.call(SORTS, key)
    ? key
    : DEFAULT_SORT;
}


async function listGoalProducts({
  shop,
  page,
  limit,
  search,
  sort,
  inStock = false,
  productType = ""
}) {

  const filter = {
    shop
  };


  // Optional filters. Absent = same results as before.
  if (inStock) {

    filter.availableForSale = true;
  }


  const cleanType =
    String(
      productType || ""
    ).trim().slice(0, 200);


  if (cleanType) {

    filter.productType = cleanType;
  }


  const cleanSearch =
    String(
      search || ""
    ).trim().slice(0, 200);


  if (cleanSearch) {

    const regex =
      new RegExp(
        escapeRegex(cleanSearch),
        "i"
      );


    filter.$or = [
      { title: regex },
      { sku: regex },
      { handle: regex }
    ];
  }


  const skip =
    (page - 1) * limit;


  const results =
    await Product.find(filter)

      .select(LIST_FIELDS)

      /*
       * title/sku give a stable, human-browsable order. _id is
       * an extra tiebreaker so pagination stays stable when
       * titles repeat.
       */
      .sort(
        SORTS[normalizeSort(sort)]
      )

      .skip(skip)

      /*
       * One extra document reveals whether another page exists
       * without a second query.
       */
      .limit(limit + 1)

      .lean();


  const hasMore =
    results.length > limit;


  const products =
    hasMore
      ? results.slice(0, limit)
      : results;


  return {
    products,
    page,
    limit,
    hasMore
  };
}


/*
 * Product types that exist in this shop's synced catalog, for
 * the picker's "Product type" filter (like a theme's filter
 * list: only real values, alphabetical).
 */
async function listProductTypes(shop, { inStock = false } = {}) {

  const types =
    await Product.distinct(
      "productType",
      inStock
        ? { shop, availableForSale: true }
        : { shop }
    );

  return Array.from(
    new Set(
      types
        .map(type => String(type || "").trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}


module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SORTS,
  clampInt,
  listGoalProducts,
  listProductTypes,
  normalizeSort
};
