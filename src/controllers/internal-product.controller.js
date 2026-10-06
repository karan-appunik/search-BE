const Product = require("../models/Product");

const {
  buildEmbeddingText,
  getEmbeddingHash,
  createEmbeddings,
  OLLAMA_EMBEDDING_MODEL
} = require("../services/ai/embedding.service");

const {
  upsertProducts,
  deleteProductPoints,
  invalidateShop
} = require("../services/search/vector.service");


/*
 * ---------------------------------------------------------
 * SHARED VARIANT UPSERT
 * ---------------------------------------------------------
 *
 * Used by both the full sync and the products/create|update
 * webhook, so both write exactly the same document shape.
 *
 * The Shopify variant ID is the identity (it never changes);
 * sku is optional and matchKey falls back to the variant ID.
 * Resolves to the matchKey the document had BEFORE this write
 * (null for a new document), so callers can drop a stale vector
 * point whose key just changed.
 */

const upsertVariant = async (
  shop,
  currency,
  product,
  variant
) => {

  const sku =
    String(variant?.sku || "").trim();

  const matchKey =
    Product.buildMatchKey(
      sku,
      variant.id
    );

  const image =
    variant?.image?.url ||
    product?.featuredImage?.url ||
    "";


  const previous = await Product.findOneAndUpdate(

    {
      shop,

      shopifyVariantId:
        variant.id
    },

    {

      shop,

      sku,

      matchKey,

      shopifyProductId:
        product.id,

      shopifyVariantId:
        variant.id,

      shopifyInventoryItemId:
        variant?.inventoryItem?.id || "",


      handle:
        product.handle || "",

      title:
        product.title || "",

      description:
        product.description || "",

      productType:
        product.productType || "",

      vendor:
        product.vendor || "",

      tags:
        product.tags || [],

      price:
        Number(
          variant.price || 0
        ),

      compareAtPrice:
        variant.compareAtPrice
          ? Number(
            variant.compareAtPrice
          )
          : null,

      currency:
        currency || "USD",

      image,

      /*
       * Keep the real Shopify storefront URL.
       */

      productUrl:
        product.onlineStoreUrl || "",

      availableForSale:
        Boolean(
          variant.availableForSale
        ),

      inventoryQuantity:
        Number(
          variant.inventoryQuantity || 0
        )

    },

    {
      upsert: true,

      returnDocument:
        "before",

      setDefaultsOnInsert:
        true
    }

  )
    .select("matchKey")
    .lean();


  return previous?.matchKey || null;
};


/*
 * ---------------------------------------------------------
 * BEST-EFFORT VECTOR REFRESH
 * ---------------------------------------------------------
 *
 * Re-embeds only variants whose embedding text actually
 * changed (price/stock edits leave it untouched), and removes
 * cached vectors for variants that were deleted. Runs after
 * the webhook response is sent, so a slow or offline Ollama
 * never makes Shopify retry the webhook. Anything missed here
 * is picked up by `npm run index:products`.
 */

/*
 * Shopify often sends create + update for the same product
 * seconds apart. Refreshes for one product are chained so a
 * slow earlier embedding can't re-insert a point that a later
 * webhook already deleted.
 */
const refreshQueues = new Map();

const EMBEDDING_BATCH_SIZE = 4;

const refreshVectors = (
  shop,
  shopifyProductId,
  loadProducts,
  removedMatchKeys
) => {

  const key =
    `${shop}:${shopifyProductId}`;

  const previous =
    refreshQueues.get(key) ||
    Promise.resolve();

  const next =
    previous.then(
      () =>
        runVectorRefresh(
          shop,
          loadProducts,
          removedMatchKeys
        )
    );

  refreshQueues.set(
    key,
    next
  );

  next.finally(() => {
    if (
      refreshQueues.get(key) ===
      next
    ) {
      refreshQueues.delete(key);
    }
  });

  return next;
};

const runVectorRefresh = async (
  shop,
  loadProducts,
  removedMatchKeys
) => {

  try {

    const products =
      await loadProducts();


    await deleteProductPoints(
      shop,
      removedMatchKeys
    );


    const texts =
      products.map(
        buildEmbeddingText
      );

    const changed =
      products
        .map(
          (product, index) => ({
            product,
            text:
              texts[index],
            hash:
              getEmbeddingHash(
                texts[index]
              )
          })
        )
        .filter(
          item =>
            item.hash !==
            item.product.embeddingHash ||
            // e.g. vectors that only ever lived in Qdrant
            item.product.hasEmbedding !== true
        );


    if (
      !changed.length
    ) {

      return;
    }


    /*
     * Same batch size as scripts/index-products.js, so a full
     * sync of a large catalog never sends one huge embedding
     * request.
     */
    for (
      let offset = 0;
      offset < changed.length;
      offset += EMBEDDING_BATCH_SIZE
    ) {

      const batch =
        changed.slice(
          offset,
          offset + EMBEDDING_BATCH_SIZE
        );


      const embeddings =
        await createEmbeddings(
          batch.map(
            item =>
              item.text
          )
        );


      await upsertProducts(
        batch.map(
          item =>
            item.product
        ),
        embeddings
      );


      await Product.bulkWrite(
        batch.map(
          item => ({
            updateOne: {
              filter: {
                _id:
                  item.product._id
              },
              update: {
                $set: {
                  embeddingText:
                    item.text,
                  embeddingHash:
                    item.hash,
                  embeddingModel:
                    OLLAMA_EMBEDDING_MODEL,
                  embeddingIndexedAt:
                    new Date()
                }
              }
            }
          })
        ),
        {
          ordered:
            false
        }
      );

    }


    console.log(
      "[PRODUCT WEBHOOK] Vectors refreshed",
      {
        shop,
        reembedded:
          changed.length,
        removed:
          removedMatchKeys.length
      }
    );

  } catch (error) {

    console.error(
      "[PRODUCT WEBHOOK] Vector refresh failed (run `npm run index:products` to catch up):",
      error.message
    );
  }
};


const syncProducts = async (req, res) => {

  try {

    const {
      shop,
      currency,
      products
    } = req.body;


    /*
     * ---------------------------------------------------------
     * VALIDATION
     * ---------------------------------------------------------
     */

    if (!shop) {

      return res.status(400).json({

        success: false,

        message:
          "Shop is required"

      });
    }


    if (!Array.isArray(products)) {

      return res.status(400).json({

        success: false,

        message:
          "Products must be an array"

      });
    }


    let synced = 0;

    let skipped = 0;

    const skippedItems = [];


    /*
     * ---------------------------------------------------------
     * TRACK CURRENT SHOPIFY RECORDS
     * ---------------------------------------------------------
     *
     * We collect the Shopify variant IDs that are currently
     * present in Shopify and have valid SKUs.
     */

    const currentVariantIds = [];


    /*
     * ---------------------------------------------------------
     * SYNC SHOPIFY PRODUCTS → MONGODB
     * ---------------------------------------------------------
     */

    for (
      const product
      of products
    ) {

      const variants =
        product?.variants?.nodes || [];


      for (
        const variant
        of variants
      ) {

        /*
         * SKU is optional (Shopify never requires one). The
         * variant ID is the only thing a variant must have.
         */

        if (!variant?.id) {

          skipped++;

          skippedItems.push({
            productId:
              product?.id || null,

            title:
              product?.title || "",

            reason:
              "Variant has no Shopify variant ID"
          });

          continue;
        }


        currentVariantIds.push(
          variant.id
        );


        await upsertVariant(
          shop,
          currency,
          product,
          variant
        );


        synced++;

      }

    }


    /*
     * ---------------------------------------------------------
     * REMOVE STALE MONGODB PRODUCTS
     * ---------------------------------------------------------
     *
     * At this point we have fetched the COMPLETE Shopify
     * catalog.
     *
     * So any MongoDB product whose Shopify variant ID is not
     * present anymore should be deleted.
     */

    /*
     * With no current variants, $nin [] matches every product of
     * this shop, so the shop's whole AI catalog is removed.
     */
    const staleFilter = {

      shop,

      shopifyVariantId: {
        $nin:
          currentVariantIds
      }

    };


    const staleMatchKeys =
      (
        await Product.find(staleFilter)
          .select("matchKey")
          .lean()
      ).map(
        product =>
          product.matchKey
      );


    const deleteResult =
      await Product.deleteMany(
        staleFilter
      );


    const deleted =
      deleteResult.deletedCount || 0;

    // Stock may have changed: refresh the in-memory vector set.
    invalidateShop(shop);


    /*
     * ---------------------------------------------------------
     * RESULT
     * ---------------------------------------------------------
     */

    console.log(
      "[MONGODB PRODUCT SYNC]",
      {
        shop,

        received:
          products.length,

        synced,

        skipped,

        currentVariants:
          currentVariantIds.length,

        deleted
      }
    );


    res.status(200).json({

      success: true,

      message:
        "Products synced successfully",

      data: {

        synced,

        skipped,

        skippedItems,

        deleted,

        totalReceived:
          products.length,

        totalCurrentVariants:
          currentVariantIds.length

      }

    });


    return {
      shop,
      staleMatchKeys
    };


  } catch (error) {

    console.error(
      "MongoDB product sync error:",
      error
    );


    return res.status(500).json({

      success: false,

      message:
        "MongoDB product sync failed"
    });

  }
};


// =========================================================
// WEBHOOK: PRODUCT CREATE / UPDATE
// =========================================================
//
// Body: { shop, currency, product } where product is the same
// GraphQL shape the full sync receives. Variants of this
// product that are no longer in Shopify (or lost their SKU)
// are removed.
// =========================================================

const webhookUpsertProduct = async (req, res) => {

  try {

    const { shop, currency, product } = req.body;

    if (!shop) {
      return res.status(400).json({ success: false, message: "Shop is required" });
    }

    if (!product?.id) {
      return res.status(400).json({ success: false, message: "Product with id is required" });
    }

    const variants =
      product?.variants?.nodes || [];

    const currentVariantIds = [];

    let synced = 0;

    let skipped = 0;


    const changedMatchKeys = [];

    for (const variant of variants) {

      if (!variant?.id) {
        skipped++;
        continue;
      }

      currentVariantIds.push(variant.id);

      const previousMatchKey =
        await upsertVariant(
          shop,
          currency,
          product,
          variant
        );

      const matchKey =
        Product.buildMatchKey(
          variant.sku,
          variant.id
        );

      if (
        previousMatchKey &&
        previousMatchKey !== matchKey
      ) {
        changedMatchKeys.push(previousMatchKey);
      }

      synced++;
    }


    const staleFilter = {
      shop,
      shopifyProductId: product.id,
      shopifyVariantId: { $nin: currentVariantIds }
    };

    const stale =
      await Product.find(staleFilter)
        .select("matchKey")
        .lean();

    const deleteResult =
      await Product.deleteMany(staleFilter);

    const deleted =
      deleteResult.deletedCount || 0;


    // Stock may have changed: refresh the in-memory vector set.
    invalidateShop(shop);

    console.log("[PRODUCT WEBHOOK] Upsert", {
      shop,
      shopifyProductId: product.id,
      synced,
      skipped,
      deleted
    });


    res.status(200).json({
      success: true,
      message: "Product webhook processed",
      data: { synced, skipped, deleted }
    });


    refreshVectors(
      shop,
      product.id,
      () =>
        Product.find({
          shop,
          shopifyProductId: product.id
        }).lean(),
      [
        ...stale.map(item => item.matchKey),
        ...changedMatchKeys
      ]
    );

  } catch (error) {

    console.error("[PRODUCT WEBHOOK] Upsert error:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Product webhook upsert failed"
      });
    }
  }
};


// =========================================================
// WEBHOOK: PRODUCT DELETE
// =========================================================

const webhookDeleteProduct = async (req, res) => {

  try {

    const { shop, shopifyProductId } = req.body;

    if (!shop) {
      return res.status(400).json({ success: false, message: "Shop is required" });
    }

    if (!shopifyProductId) {
      return res.status(400).json({ success: false, message: "shopifyProductId is required" });
    }

    const filter = { shop, shopifyProductId };

    const removed =
      await Product.find(filter)
        .select("matchKey")
        .lean();

    const deleteResult =
      await Product.deleteMany(filter);

    const variantsRemoved =
      deleteResult.deletedCount || 0;


    console.log("[PRODUCT WEBHOOK] Delete", {
      shop,
      shopifyProductId,
      variantsRemoved
    });


    res.status(200).json({
      success: true,
      message: "Product delete webhook processed",
      data: { variantsRemoved }
    });


    refreshVectors(
      shop,
      shopifyProductId,
      async () => [],
      removed.map(item => item.matchKey)
    );

  } catch (error) {

    console.error("[PRODUCT WEBHOOK] Delete error:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Product webhook delete failed"
      });
    }
  }
};


/*
 * Route handler for the full sync: runs the Mongo sync, then
 * brings vectors up to date in the background (new or changed
 * products embedded, deleted ones removed). Kept separate from
 * syncProducts so the Mongo-only tests never compute embeddings.
 */
const syncProductsAndRefreshVectors = async (req, res) => {

  const result =
    await syncProducts(req, res);


  if (!result) {
    return;
  }


  refreshVectors(
    result.shop,
    "*full-sync*",
    () =>
      Product.find({
        shop: result.shop
      }).lean(),
    result.staleMatchKeys
  );
};


module.exports = {
  syncProducts,
  syncProductsAndRefreshVectors,
  webhookUpsertProduct,
  webhookDeleteProduct
};