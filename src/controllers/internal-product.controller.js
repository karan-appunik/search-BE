const Product = require("../models/Product");


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

        const sku =
          variant?.sku?.trim();


        /*
         * SKU is mandatory for AI search.
         */

        if (!sku) {

          skipped++;

          continue;
        }


        /*
         * Remember current Shopify variant.
         */

        if (variant.id) {

          currentVariantIds.push(
            variant.id
          );

        }


        /*
         * -----------------------------------------------------
         * IMAGE
         * -----------------------------------------------------
         */

        const image =
          variant?.image?.url ||
          product?.featuredImage?.url ||
          "";


        /*
         * -----------------------------------------------------
         * UPSERT
         * -----------------------------------------------------
         */

        await Product.findOneAndUpdate(

          {
            shop,

            sku
          },

          {

            shop,

            sku,

            shopifyProductId:
              product.id,

            shopifyVariantId:
              variant.id,


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

            new: true,

            setDefaultsOnInsert:
              true
          }

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

    let deleted = 0;


    if (
      currentVariantIds.length === 0
    ) {

      /*
       * Shopify currently has no SKU-bearing variants.
       *
       * Therefore this shop should have no AI catalog.
       */

      const deleteResult =
        await Product.deleteMany({
          shop
        });


      deleted =
        deleteResult.deletedCount || 0;

    } else {

      const deleteResult =
        await Product.deleteMany({

          shop,

          shopifyVariantId: {
            $nin:
              currentVariantIds
          }

        });


      deleted =
        deleteResult.deletedCount || 0;

    }


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
        "MongoDB product sync failed",

      error:
        error.message

    });

  }
};


module.exports = {
  syncProducts
};