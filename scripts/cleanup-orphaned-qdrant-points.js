require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../src/models/Product");

// =========================================================
// ONE-TIME CLEANUP: orphaned Qdrant points
// =========================================================
//
// Deleting a product from MongoDB has never told Qdrant to
// remove the matching semantic-search entry — Qdrant just kept
// it forever. This script finds every Qdrant point whose
// {shop, matchKey} no longer has a matching MongoDB product, and
// removes it.
//
// Read-only against MongoDB. Only deletes from Qdrant, and only
// entries that are provably orphaned (no matching product exists
// for that exact shop + matchKey pair).
//
// Safe to re-run — once nothing is orphaned, it does nothing.
// =========================================================

const QDRANT_URL =
  (process.env.QDRANT_URL || "http://localhost:6333").replace(/\/+$/, "");

const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";

const COLLECTION_NAME =
  process.env.QDRANT_COLLECTION || "shopify_product_search";

const SCROLL_BATCH_SIZE = 200;
const DELETE_BATCH_SIZE = 200;

function getHeaders() {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
  return headers;
}

async function scrollAllPoints() {
  const points = [];
  let offset = null;
  let hasMore = true;

  while (hasMore) {
    const body = {
      limit: SCROLL_BATCH_SIZE,
      with_payload: true,
      with_vector: false
    };
    if (offset) body.offset = offset;

    const response = await fetch(
      `${QDRANT_URL}/collections/${encodeURIComponent(COLLECTION_NAME)}/points/scroll`,
      { method: "POST", headers: getHeaders(), body: JSON.stringify(body) }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Qdrant scroll failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const batch = data.result?.points || [];
    points.push(...batch);

    offset = data.result?.next_page_offset || null;
    hasMore = Boolean(offset) && batch.length > 0;
  }

  return points;
}

async function deletePointIds(ids) {
  for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
    const batch = ids.slice(i, i + DELETE_BATCH_SIZE);

    const response = await fetch(
      `${QDRANT_URL}/collections/${encodeURIComponent(COLLECTION_NAME)}/points/delete`,
      {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ points: batch })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Qdrant delete failed: ${response.status} ${errorText}`);
    }

    console.log(`[CLEANUP] Deleted ${Math.min(i + DELETE_BATCH_SIZE, ids.length)}/${ids.length} orphaned points`);
  }
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("[CLEANUP] Connected to MongoDB");

  console.log("[CLEANUP] Scrolling all Qdrant points...");
  const points = await scrollAllPoints();
  console.log(`[CLEANUP] Qdrant currently has ${points.length} point(s)`);

  // Build the set of {shop, matchKey} pairs that actually exist
  // in MongoDB right now, across every shop. Also index by
  // {shop, sku} for points embedded before the matchKey payload
  // field existed — every product had a real, non-empty sku back
  // then (SKU used to be mandatory), so sku is just as reliable
  // an identity check for those older entries.
  const liveProducts = await Product.find({}).select("shop matchKey sku").lean();

  const liveKeySet = new Set(
    liveProducts.map(p => `${p.shop}::${p.matchKey}`)
  );

  const liveSkuSet = new Set(
    liveProducts
      .filter(p => p.sku)
      .map(p => `${p.shop}::${p.sku}`)
  );

  console.log(`[CLEANUP] MongoDB currently has ${liveProducts.length} product(s)`);

  const orphanedIds = [];
  let uncheckable = 0;

  for (const point of points) {
    const shop = point.payload?.shop;
    const matchKey = point.payload?.matchKey;
    const sku = point.payload?.sku;

    if (shop && matchKey) {
      if (!liveKeySet.has(`${shop}::${matchKey}`)) {
        orphanedIds.push(point.id);
      }
      continue;
    }

    // Legacy point, embedded before matchKey existed in the
    // payload — fall back to checking by sku instead.
    if (shop && sku) {
      if (!liveSkuSet.has(`${shop}::${sku}`)) {
        orphanedIds.push(point.id);
      }
      continue;
    }

    // No usable identity at all — cannot prove orphaned, so it's
    // left alone rather than guessed at.
    uncheckable++;
  }

  console.log(`[CLEANUP] Orphaned points found: ${orphanedIds.length}`);
  if (uncheckable) {
    console.log(`[CLEANUP] Skipped ${uncheckable} point(s) with no usable shop/sku/matchKey payload (left untouched)`);
  }

  if (orphanedIds.length) {
    await deletePointIds(orphanedIds);
  } else {
    console.log("[CLEANUP] Nothing to delete");
  }

  console.log("[CLEANUP] DONE");
}

main()
  .catch(error => {
    console.error("[CLEANUP] FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
