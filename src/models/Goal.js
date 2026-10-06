const mongoose = require("mongoose");


// =========================================================
// GOAL PRODUCT SNAPSHOT
// =========================================================
//
// Display-only copy of the selected product so the admin UI
// can render the goal without a second Shopify round-trip.
//
// The `skus` array on the goal remains the source of truth.
// =========================================================

const goalProductSchema =
  new mongoose.Schema(
    {
      // PRIMARY PRODUCT MATCHING KEY (see Product.js)
      matchKey: {
        type: String,
        default: ""
      },

      // Display only; "" for a product without a SKU.
      sku: {
        type: String,
        default: ""
      },

      shopifyProductId: {
        type: String,
        default: ""
      },

      shopifyVariantId: {
        type: String,
        default: ""
      },

      title: {
        type: String,
        default: ""
      },

      image: {
        type: String,
        default: ""
      }
    },

    {
      _id: false
    }
  );


const goalSchema =
  new mongoose.Schema(
    {
      /*
       * Shopify shop domain.
       *
       * Example:
       * "product-finder-iugajakd.myshopify.com"
       *
       * This is the tenant boundary. Every goal query must be
       * scoped by it.
       */
      shop: {
        type: String,
        required: true,
        trim: true
      },

      name: {
        type: String,
        required: true,
        trim: true,
        maxlength: 120
      },

      /*
       * Selected products' matchKeys (the real SKU, or
       * "variant:<gid>" for a product without one). The field
       * keeps its original name so the API shape is unchanged.
       */
      skus: {
        type: [String],
        default: []
      },

      products: {
        type: [goalProductSchema],
        default: []
      },

      /*
       * What the rule does to the selected products in search.
       * null until the seller picks one. Values must match
       * rule-application.service.js's RULE_TYPES.
       */
      ruleType: {
        type: String,
        enum: ["boost", "exclude", "demote", null],
        default: null
      },

      enabled: {
        type: Boolean,
        default: true
      }
    },

    {
      timestamps: true
    }
  );


// =========================================================
// ONE GOAL PER SHOP
// =========================================================
//
// This unique index is the actual guarantee that a shop can
// never hold more than one goal. Application code additionally
// uses a single upsert instead of create/update branches, and
// the admin UI hides the create action once a goal exists, but
// this index is what enforces the rule.
// =========================================================

goalSchema.index(
  {
    shop: 1
  },
  {
    unique: true,
    name: "goal_shop_unique"
  }
);


module.exports =
  mongoose.model(
    "Goal",
    goalSchema
  );
