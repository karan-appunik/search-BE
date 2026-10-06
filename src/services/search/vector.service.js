const Product = require("../../models/Product");


// =========================================================
// VECTOR SEARCH (MongoDB, in-process)
// =========================================================
//
// Replaces the external Qdrant service. Each product's
// embedding is stored on its own MongoDB document
// (Product.embedding, never loaded by normal queries), and
// similarity is computed here:
//
//   - the first search for a shop loads that shop's vectors
//     into memory once (Float32Array, pre-normalised);
//   - every search after that is a plain cosine-similarity scan
//     in memory, a few milliseconds for catalogs of this size;
//   - any write for a shop drops its cache, and a short TTL
//     covers writes made by other processes (e.g. the
//     index-products script).
//
// Result shape matches what search.service.js and JEV already
// use: [{ score, payload: { shop, sku, matchKey, ... } }],
// where score is cosine similarity (same scale Qdrant's Cosine
// distance returned, so JEV thresholds are unchanged).
// =========================================================

const CACHE_TTL_MS = 60 * 1000;

const shopCache = new Map();

const shopLoads = new Map();


function normalise(vector) {

  const values = Float32Array.from(vector);

  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i] * values[i];
  }

  const norm = Math.sqrt(sum);

  if (norm > 0) {
    for (let i = 0; i < values.length; i++) {
      values[i] /= norm;
    }
  }

  return values;
}


function invalidateShop(shop) {

  shopCache.delete(shop);
}


async function loadShopVectors(shop) {

  const cached = shopCache.get(shop);

  if (
    cached &&
    Date.now() - cached.loadedAt < CACHE_TTL_MS
  ) {
    return cached.items;
  }


  // Concurrent first searches for one shop share a single load.
  if (shopLoads.has(shop)) {
    return shopLoads.get(shop);
  }


  // Sold-out products are never shown to customers, so they
  // must not take similarity-search slots either. Stock changes
  // refresh this cache (invalidateShop) via sync and webhooks.
  const load = Product.find({
    shop,
    hasEmbedding: true,
    availableForSale: true
  })
    .select("+embedding shop sku matchKey shopifyProductId shopifyVariantId title")
    .lean()
    .then(products => {

      const items = products
        .filter(product =>
          Array.isArray(product.embedding) &&
          product.embedding.length
        )
        .map(product => ({
          vector: normalise(product.embedding),
          payload: {
            shop: product.shop,
            sku: product.sku || "",
            matchKey: product.matchKey || product.sku,
            shopifyProductId: product.shopifyProductId || "",
            shopifyVariantId: product.shopifyVariantId || "",
            title: product.title || ""
          }
        }));

      shopCache.set(shop, {
        loadedAt: Date.now(),
        items
      });

      return items;
    })
    .finally(() => {
      shopLoads.delete(shop);
    });


  shopLoads.set(shop, load);

  return load;
}


// =========================================================
// STORE EMBEDDINGS
// =========================================================

async function upsertProducts(
  products,
  embeddings
) {

  if (
    !products.length
  ) {
    return;
  }


  if (
    products.length !==
    embeddings.length
  ) {
    throw new Error(
      "Product / embedding count mismatch"
    );
  }


  await Product.bulkWrite(
    products.map(
      (product, index) => ({
        updateOne: {
          filter: {
            _id: product._id
          },
          update: {
            $set: {
              embedding: Array.from(embeddings[index]),
              hasEmbedding: true
            }
          }
        }
      })
    ),
    {
      ordered: false
    }
  );


  for (const shop of new Set(products.map(product => product.shop))) {
    invalidateShop(shop);
  }
}


// =========================================================
// VECTOR SEARCH
// =========================================================

async function searchByVector(
  embedding,
  {
    shop,
    limit = 30
  } = {}
) {

  if (
    !Array.isArray(embedding) ||
    !embedding.length
  ) {
    return [];
  }


  /*
   * Vectors are per shop. Searching without one would mix
   * tenants, so a missing shop is a bug, never "search all".
   */
  if (
    !String(shop || "").trim()
  ) {
    throw new Error(
      "searchByVector: shop is required"
    );
  }


  const items = await loadShopVectors(shop);

  if (!items.length) {
    return [];
  }


  const query = normalise(embedding);

  const scored = [];

  for (const item of items) {

    const vector = item.vector;

    if (vector.length !== query.length) {
      continue;
    }

    let dot = 0;

    for (let i = 0; i < query.length; i++) {
      dot += query[i] * vector[i];
    }

    scored.push({
      score: dot,
      payload: item.payload
    });
  }


  const max =
    Math.min(
      Math.max(
        Number(limit) || 30,
        1
      ),
      100
    );


  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}


// =========================================================
// DELETE
// =========================================================
//
// Embeddings live on the product documents, so deleting a
// product deletes its vector. Only the in-memory cache needs
// refreshing.
// =========================================================

async function deleteProductPoints(
  shop,
  matchKeys
) {

  if (
    !Array.isArray(matchKeys) ||
    !matchKeys.length
  ) {
    return;
  }

  invalidateShop(shop);
}


// =========================================================
// STATUS (read-only, never throws)
// =========================================================

async function getVectorIndexStatus() {

  try {

    const [
      productsWithVectors,
      productsTotal
    ] = await Promise.all([
      Product.countDocuments({ hasEmbedding: true }),
      Product.countDocuments({})
    ]);


    return {
      reachable: true,
      storage: "mongodb",
      pointsCount: productsWithVectors,
      productsWithoutVectors: Math.max(0, productsTotal - productsWithVectors)
    };

  } catch (error) {

    return {
      reachable: null,
      storage: "mongodb",
      pointsCount: null,
      note: "unavailable"
    };
  }
}


module.exports = {
  upsertProducts,
  searchByVector,
  deleteProductPoints,
  getVectorIndexStatus,
  invalidateShop
};
