const Product =
  require("../../models/Product");

const {
  shopifyGraphQL
} =
  require("./shopify.service");


// =========================================================
// SHOPIFY PRODUCTS QUERY
// =========================================================

const PRODUCTS_QUERY = `
  query GetProducts(
    $first: Int!
    $after: String
  ) {

    shop {
      currencyCode
    }

    products(
      first: $first
      after: $after
      query: "status:active"
    ) {

      nodes {

        id

        handle

        title

        description

        productType

        vendor

        tags

        onlineStoreUrl

        featuredImage {
          url
          altText
        }

        variants(
          first: 100
        ) {

          nodes {

            id

            title

            sku

            barcode

            selectedOptions {
              name
              value
            }

            price

            compareAtPrice

            availableForSale

            inventoryQuantity

            image {
              url
              altText
            }

          }

        }

      }

      pageInfo {
        hasNextPage
        endCursor
      }

    }

  }
`;


// =========================================================
// NORMALIZE VARIANT
// =========================================================

const normalizeProductVariant =
  ({
    shop,
    product,
    variant,
    currency
  }) => {

    /*
     * Variants without SKU are intentionally
     * excluded from the AI product catalog.
     */
    if (
      !variant?.sku
    ) {
      return null;
    }


    return {

      shop,

      sku:
        variant.sku.trim(),

      shopifyProductId:
        product.id,

      shopifyVariantId:
        variant.id,

      handle:
        product.handle ||
        "",

      variantTitle:
        variant.title ||
        "",

      variantOptions:
        Array.isArray(
          variant.selectedOptions
        )
          ? variant.selectedOptions.map(
              option =>
                `${option.name}: ${option.value}`
            )
          : [],

      barcode:
        variant.barcode ||
        "",

      title:
        product.title,

      description:
        product.description ||
        "",

      productType:
        product.productType ||
        "",

      vendor:
        product.vendor ||
        "",

      tags:
        Array.isArray(
          product.tags
        )
          ? product.tags
          : [],

      /*
       * These remain available for your
       * future richer catalogs.
       */
      ingredients: [],

      benefits: [],

      features: [],

      price:
        Number(
          variant.price ||
          0
        ),

      compareAtPrice:
        variant.compareAtPrice
          ? Number(
              variant.compareAtPrice
            )
          : null,

      currency:
        currency ||
        "USD",

      image:
        variant.image?.url ||
        product.featuredImage?.url ||
        "",

      images: [],

      productUrl:
        product.onlineStoreUrl ||
        "",

      availableForSale:
        Boolean(
          variant.availableForSale
        ),

      inventoryQuantity:
        Number(
          variant.inventoryQuantity ||
          0
        )

    };

  };


// =========================================================
// SYNC PRODUCTS
// =========================================================

const syncProducts =
  async ({
    shop
  }) => {

    if (!shop) {

      throw new Error(
        "Shop is required"
      );

    }


    let hasNextPage =
      true;

    let after =
      null;


    let synced =
      0;

    let skipped =
      0;


    /*
     * Current Shopify catalog trackers.
     *
     * We only delete stale MongoDB records
     * after ALL Shopify pages have been
     * successfully retrieved.
     */
    const currentProductIds =
      [];

    const currentVariantIds =
      [];


    let currency =
      "USD";


    // =======================================================
    // FETCH ALL SHOPIFY PRODUCTS
    // =======================================================

    while (
      hasNextPage
    ) {

      const data =
        await shopifyGraphQL(
          PRODUCTS_QUERY,
          {
            first:
              100,

            after
          }
        );


      const products =
        data?.products;


      if (!products) {

        throw new Error(
          "Invalid Shopify products response"
        );

      }


      currency =
        data?.shop?.currencyCode ||
        currency ||
        "USD";


      // -----------------------------------------------------
      // PRODUCTS
      // -----------------------------------------------------

      for (
        const product
        of products.nodes || []
      ) {

        currentProductIds.push(
          product.id
        );


        // ---------------------------------------------------
        // VARIANTS
        // ---------------------------------------------------

        for (
          const variant
          of product.variants?.nodes ||
          []
        ) {

          const normalizedProduct =
            normalizeProductVariant({

              shop,

              product,

              variant,

              currency

            });


          /*
           * Variant without SKU:
           * don't store it.
           */
          if (
            !normalizedProduct
          ) {

            skipped++;

            continue;

          }


          currentVariantIds.push(
            variant.id
          );


          /*
           * Upsert by shop + SKU.
           */
          await Product.findOneAndUpdate(

            {
              shop,

              sku:
                normalizedProduct.sku
            },

            normalizedProduct,

            {
              upsert:
                true,

              new:
                true,

              setDefaultsOnInsert:
                true
            }

          );


          synced++;

        }

      }


      hasNextPage =
        Boolean(
          products.pageInfo?.hasNextPage
        );


      after =
        products.pageInfo?.endCursor ||
        null;

    }


    // =======================================================
    // REMOVE STALE RECORDS
    // =======================================================

    let deletedProducts =
      0;


    /*
     * Shopify currently has no active products.
     */
    if (
      currentProductIds.length ===
      0
    ) {

      const deleteResult =
        await Product.deleteMany({
          shop
        });


      deletedProducts =
        deleteResult.deletedCount ||
        0;

    } else {

      /*
       * Delete:
       *
       * 1. Products no longer present
       * 2. Variants no longer present
       * 3. Variants that disappeared / lost SKU
       */
      const deleteResult =
        await Product.deleteMany({

          shop,

          $or: [

            {
              shopifyProductId: {
                $nin:
                  currentProductIds
              }
            },

            {
              shopifyVariantId: {
                $nin:
                  currentVariantIds
              }
            }

          ]

        });


      deletedProducts =
        deleteResult.deletedCount ||
        0;

    }


    // =======================================================
    // LOG
    // =======================================================

    console.log(
      "[SHOPIFY SYNC] Complete",
      {

        shop,

        synced,

        skipped,

        shopifyProducts:
          currentProductIds.length,

        shopifyVariants:
          currentVariantIds.length,

        deleted:
          deletedProducts

      }
    );


    return {

      synced,

      skipped,

      deleted:
        deletedProducts

    };

  };


module.exports = {
  syncProducts
};