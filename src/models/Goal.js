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
      // PRIMARY PRODUCT MATCHING KEY
      sku: {
        type: String,
        required: true
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
       * Selected product SKUs.
       *
       * SKU is the application's product identifier everywhere
       * else (AI catalog, Qdrant payloads, result hydration), so
       * the goal uses it too.
       */
      skus: {
        type: [String],
        default: []
      },

      products: {
        type: [goalProductSchema],
        default: []
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
