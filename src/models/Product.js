const mongoose = require("mongoose");

const productSchema =
  new mongoose.Schema(
    {
      shop: {
        type: String,
        required: true,
        index: true
      },

      // PRIMARY PRODUCT MATCHING KEY
      sku: {
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
      }
    },

    {
      timestamps: true
    }
  );


// =========================================================
// UNIQUE PRODUCT / VARIANT KEY
// =========================================================

productSchema.index(
  {
    shop: 1,
    sku: 1
  },
  {
    unique: true
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


module.exports =
  mongoose.model(
    "Product",
    productSchema
  );