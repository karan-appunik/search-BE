const mongoose = require("mongoose");

const productSchema =
  new mongoose.Schema(
    {
      shop: {
        type: String,
        required: true,
        index: true
      },

      /*
       * Merchant-entered SKU. Optional: Shopify does not require
       * one, so this may be "". Display value only — never use it
       * as an identity; use matchKey.
       */
      sku: {
        type: String,
        default: ""
      },

      /*
       * PRIMARY PRODUCT MATCHING KEY
       *
       * The real SKU when there is one, otherwise
       * "variant:<shopifyVariantId>". Vector payloads, goal
       * selections and the AI catalog all key on this.
       */
      matchKey: {
        type: String,
        required: true
      },

      shopifyProductId: {
        type: String,
        required: true
      },

      shopifyVariantId: {
        type: String,
        required: true
      },

      /*
       * Needed by the inventory_levels/update webhook, whose
       * payload only carries an inventory item id.
       */
      shopifyInventoryItemId: {
        type: String,
        default: "",
        index: true
      },

      title: {
        type: String,
        required: true
      },

      /*
       * Shopify variant title.
       *
       * Examples:
       * "Black / 256GB"
       * "Medium / Red"
       */
      variantTitle: {
        type: String,
        default: ""
      },

      /*
       * Variant options.
       *
       * Examples:
       * [
       *   "Color: Black",
       *   "Storage: 256GB"
       * ]
       */
      variantOptions: {
        type: [String],
        default: []
      },

      /*
       * Variant barcode when Shopify provides one.
       */
      barcode: {
        type: String,
        default: ""
      },

      description: {
        type: String,
        default: ""
      },

      productType: {
        type: String,
        default: ""
      },

      vendor: {
        type: String,
        default: ""
      },

      tags: {
        type: [String],
        default: []
      },

      ingredients: {
        type: [String],
        default: []
      },

      benefits: {
        type: [String],
        default: []
      },

      features: {
        type: [String],
        default: []
      },

      price: {
        type: Number,
        default: 0
      },

      compareAtPrice: {
        type: Number,
        default: null
      },

      currency: {
        type: String,
        default: "USD"
      },

      image: {
        type: String,
        default: ""
      },

      images: {
        type: [String],
        default: []
      },

      handle: {
        type: String,
        default: ""
      },

      productUrl: {
        type: String,
        default: ""
      },

      availableForSale: {
        type: Boolean,
        default: false
      },

      inventoryQuantity: {
        type: Number,
        default: 0
      },

          // =====================================================
    // SEMANTIC SEARCH METADATA
    // =====================================================

    embeddingText: {
        type: String,
        default: ""
      },

      embeddingHash: {
        type: String,
        default: ""
      },

      embeddingModel: {
        type: String,
        default: ""
      },

      embeddingIndexedAt: {
        type: Date,
        default: null
      },

      /*
       * The product's semantic vector (qwen3-embedding), used by
       * vector.service.js for JEV similarity scores. Large, so it
       * is never loaded unless a query asks for "+embedding".
       */
      embedding: {
        type: [Number],
        default: undefined,
        select: false
      },

      hasEmbedding: {
        type: Boolean,
        default: false
      }
    },

    {
      timestamps: true
    }
  );


// Loads one shop's vectors for vector.service.js.
productSchema.index({
  shop: 1,
  hasEmbedding: 1
});


// =========================================================
// UNIQUE PRODUCT / VARIANT KEY
// =========================================================

/*
 * A Shopify variant ID never changes, so it is the document's
 * identity. sku/matchKey are lookup indexes only: Shopify
 * allows the same SKU on two variants, and a variant can gain
 * or change its SKU later.
 */
productSchema.index(
  {
    shop: 1,
    shopifyVariantId: 1
  },
  {
    unique: true
  }
);

productSchema.index({
  shop: 1,
  matchKey: 1
});

productSchema.index({
  shop: 1,
  sku: 1
});


function buildMatchKey(
  sku,
  shopifyVariantId
) {

  const cleanSku =
    String(sku || "").trim();

  return cleanSku ||
    `variant:${shopifyVariantId}`;
}


/*
 * Safety net for any code path that creates a product without
 * computing matchKey itself.
 */
productSchema.pre(
  "validate",
  function setMatchKey() {

    if (
      !this.matchKey &&
      this.shopifyVariantId
    ) {

      this.matchKey =
        buildMatchKey(
          this.sku,
          this.shopifyVariantId
        );
    }

  }
);


// =========================================================
// GENERIC AI SEARCH INDEX
// =========================================================
//
// IMPORTANT:
//
// This is NOT specific to skincare, fashion,
// phones, electronics, etc.
//
// It works with whatever information exists
// in the Shopify catalog.
//
// Higher weights mean stronger lexical relevance
// during the FAST candidate retrieval step.
// =========================================================

productSchema.index(
  {
    shop: 1,

    title: "text",

    variantTitle: "text",

    description: "text",

    productType: "text",

    vendor: "text",

    tags: "text",

    ingredients: "text",

    benefits: "text",

    features: "text",

    variantOptions: "text"
  },

  {
    weights: {

      title: 10,

      variantTitle: 9,

      productType: 8,

      tags: 6,

      variantOptions: 6,

      description: 4,

      benefits: 4,

      features: 4,

      ingredients: 3,

      vendor: 2

    },

    name:
      "ai_product_search_text"
  }
);


productSchema.statics.buildMatchKey =
  buildMatchKey;


module.exports =
  mongoose.model(
    "Product",
    productSchema
  );