const Product = require("../models/Product");

// Any product write drops the shop's cached JEV catalog, so the
// next search scores the current products.
const {
  invalidateShop
} = require("../services/search/jev-index.service");


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
 * (null for a new document).
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


    const deleteResult =
      await Product.deleteMany(
        staleFilter
      );


    const deleted =
      deleteResult.deletedCount || 0;

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


    return res.status(200).json({

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


    for (const variant of variants) {

      if (!variant?.id) {
        skipped++;
        continue;
      }

      currentVariantIds.push(variant.id);

      await upsertVariant(
        shop,
        currency,
        product,
        variant
      );

      synced++;
    }


    const staleFilter = {
      shop,
      shopifyProductId: product.id,
      shopifyVariantId: { $nin: currentVariantIds }
    };

    const deleteResult =
      await Product.deleteMany(staleFilter);

    const deleted =
      deleteResult.deletedCount || 0;


    invalidateShop(shop);

    console.log("[PRODUCT WEBHOOK] Upsert", {
      shop,
      shopifyProductId: product.id,
      synced,
      skipped,
      deleted
    });


    return res.status(200).json({
      success: true,
      message: "Product webhook processed",
      data: { synced, skipped, deleted }
    });

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

    const deleteResult =
      await Product.deleteMany(filter);

    const variantsRemoved =
      deleteResult.deletedCount || 0;

    invalidateShop(shop);


    console.log("[PRODUCT WEBHOOK] Delete", {
      shop,
      shopifyProductId,
      variantsRemoved
    });


    return res.status(200).json({
      success: true,
      message: "Product delete webhook processed",
      data: { variantsRemoved }
    });

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


module.exports = {
  syncProducts,
  webhookUpsertProduct,
  webhookDeleteProduct
};