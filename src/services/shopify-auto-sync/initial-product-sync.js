require("dotenv").config();

const mongoose = require("mongoose");

const Product = require("../../models/Product");

const {
  shopifyGraphQL
} = require("../shopify/shopify.service");


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

        variants(first: 100) {

          nodes {

            id

            title

            sku

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


async function initialProductSync() {

  console.log(
    "[INITIAL SYNC] Starting..."
  );


  /*
   * ---------------------------------------------------------
   * CONNECT MONGODB
   * ---------------------------------------------------------
   */

  if (!process.env.MONGODB_URI) {

    throw new Error(
      "MONGODB_URI is missing"
    );

  }

  await mongoose.connect(
    process.env.MONGODB_URI
  );


  console.log(
    "[INITIAL SYNC] MongoDB connected"
  );


  /*
   * ---------------------------------------------------------
   * SHOP DOMAIN
   * ---------------------------------------------------------
   */

  const shop =
    process.env.SHOPIFY_STORE_DOMAIN;


  if (!shop) {

    throw new Error(
      "SHOPIFY_STORE_DOMAIN is missing"
    );

  }


  /*
   * ---------------------------------------------------------
   * FETCH ALL SHOPIFY PRODUCTS
   * ---------------------------------------------------------
   */

  let after = null;

  let hasNextPage = true;

  let totalProducts = 0;

  let synced = 0;

  let skipped = 0;


  while (hasNextPage) {

    console.log(
      "[INITIAL SYNC] Fetching Shopify page..."
    );


    const data =
      await shopifyGraphQL(
        PRODUCTS_QUERY,
        {
          first: 100,
          after
        }
      );


    const shopData =
      data.shop;

    const products =
      data.products;


    /*
     * -------------------------------------------------------
     * PROCESS PRODUCTS
     * -------------------------------------------------------
     */

    for (
      const product
      of products.nodes
    ) {

      totalProducts++;


      const variants =
        product?.variants?.nodes || [];


      for (
        const variant
        of variants
      ) {

        const sku =
          variant?.sku?.trim();


        /*
         * We only store products with SKU.
         */

        if (!sku) {

          skipped++;

          continue;

        }


        /*
         * -----------------------------------------------------
         * PRODUCT IMAGE
         * -----------------------------------------------------
         */

        const image =
          variant?.image?.url ||
          product?.featuredImage?.url ||
          "";


        /*
         * -----------------------------------------------------
         * UPSERT MONGODB PRODUCT
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
              shopData?.currencyCode ||
              "USD",

            image,

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

             returnDocument: "after",

            setDefaultsOnInsert:
              true
          }

        );


        synced++;


        console.log(
          `[INITIAL SYNC] Synced SKU: ${sku}`
        );

      }

    }


    /*
     * -------------------------------------------------------
     * PAGINATION
     * -------------------------------------------------------
     */

    hasNextPage =
      products.pageInfo.hasNextPage;


    after =
      products.pageInfo.endCursor;

  }


  /*
   * ---------------------------------------------------------
   * RESULT
   * ---------------------------------------------------------
   */

  console.log("");
  console.log(
    "========================================"
  );

  console.log(
    "[INITIAL SYNC] COMPLETE"
  );

  console.log(
    "========================================"
  );

  console.log(
    "Shop:",
    shop
  );

  console.log(
    "Shopify products:",
    totalProducts
  );

  console.log(
    "MongoDB records synced:",
    synced
  );

  console.log(
    "Variants skipped:",
    skipped
  );

  console.log(
    "========================================"
  );


  /*
   * ---------------------------------------------------------
   * CLOSE MONGODB
   * ---------------------------------------------------------
   */

  await mongoose.disconnect();

}


initialProductSync()
  .catch(async (error) => {

    console.error(
      "[INITIAL SYNC] FAILED"
    );

    console.error(
      error
    );

    try {
      await mongoose.disconnect();
    } catch {}

    process.exit(1);

  });