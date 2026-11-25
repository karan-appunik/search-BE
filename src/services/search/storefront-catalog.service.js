const Product = require("../../models/Product");
const { getActiveGoal } = require("../goal/goal.service");
const { isApplicableGoal } = require("../rules/rule-application.service");


// =========================================================
// STOREFRONT CATALOG (instant results while typing)
// =========================================================
//
// A compact list of the shop's in-stock products that the
// storefront script keeps in the browser, so it can show word
// matches on every keystroke without a server round trip. The
// AI search still runs as before and replaces these results.
//
// Read-only. Only public storefront information (title, handle,
// type, vendor, tags, SKUs). Respects the merchant rule:
//   - Exclude: those products are left out entirely, so they
//     can never appear in instant results;
//   - Boost / Demote: marked (r: 1 / -1) so instant results order
//     them like search does.
//
// Large catalogs return { enabled: false }: the storefront then
// keeps its normal flow (instant JEV + AI).
// =========================================================

// Above this many in-stock variants the list gets too big to
// send to every shopper's browser.
const MAX_VARIANTS = 6000;

// ...and at most this many products in the list.
const MAX_PRODUCTS = 3000;

const MAX_TAGS = 12;
const MAX_SKUS = 6;


function clean(value, max = 200) {
  return String(value == null ? "" : value).trim().slice(0, max);
}


async function getStorefrontCatalog(shop) {

  const variantCount = await Product.countDocuments({
    shop,
    availableForSale: true
  });

  if (variantCount > MAX_VARIANTS) {
    return { enabled: false, reason: "large_catalog" };
  }

  const [variants, goal] = await Promise.all([
    Product.find({ shop, availableForSale: true })
      .select("matchKey sku handle title productType vendor tags shopifyProductId")
      .sort({ title: 1, _id: 1 })
      .lean(),
    getActiveGoal(shop).catch(() => null)
  ]);

  const rule = isApplicableGoal(goal) ? goal : null;
  const ruleKeys = new Set(rule ? rule.skus : []);

  const byProduct = new Map();

  for (const variant of variants) {
    const handle = clean(variant.handle);

    if (!handle) {
      continue;
    }

    const id = clean(variant.shopifyProductId) || handle;
    let product = byProduct.get(id);

    if (!product) {
      product = {
        h: handle,
        t: clean(variant.title),
        y: clean(variant.productType),
        v: clean(variant.vendor),
        g: (Array.isArray(variant.tags) ? variant.tags : [])
          .map(tag => clean(tag, 60))
          .filter(Boolean)
          .slice(0, MAX_TAGS),
        k: [],
        excluded: false,
        r: 0
      };

      byProduct.set(id, product);
    }

    const sku = clean(variant.sku, 60);

    if (sku && product.k.length < MAX_SKUS && !product.k.includes(sku)) {
      product.k.push(sku);
    }

    if (rule && ruleKeys.has(variant.matchKey)) {
      if (rule.ruleType === "exclude") {
        // Never risk showing an excluded product instantly.
        product.excluded = true;
      } else if (rule.ruleType === "boost") {
        product.r = 1;
      } else if (rule.ruleType === "demote") {
        product.r = -1;
      }
    }
  }

  const products = [];

  for (const product of byProduct.values()) {
    if (product.excluded) {
      continue;
    }

    const item = { h: product.h, t: product.t };

    if (product.y) item.y = product.y;
    if (product.v) item.v = product.v;
    if (product.g.length) item.g = product.g;
    if (product.k.length) item.k = product.k;
    if (product.r) item.r = product.r;

    products.push(item);

    if (products.length > MAX_PRODUCTS) {
      return { enabled: false, reason: "large_catalog" };
    }
  }

  return {
    enabled: true,
    products
  };
}


module.exports = {
  getStorefrontCatalog,
  MAX_VARIANTS,
  MAX_PRODUCTS
};
