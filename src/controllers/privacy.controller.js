const Product = require("../models/Product");
const { deleteProductPoints } = require("../services/search/qdrant.service");
const { deleteGoal } = require("../services/goal/goal.service");

// =========================================================
// GDPR: SHOP REDACT
// =========================================================
//
// Shopify sends shop/redact ~48 hours after a shop uninstalls the
// app, and requires the app to delete everything it holds for
// that shop. Today, nothing does this: webhooks.app.uninstalled.jsx
// only clears the login session — the shop's product catalog and
// goal/rule end up orphaned in MongoDB and Qdrant forever. This is
// the actual data-deletion step, using only functions the rest of
// the app already relies on (deleteProductPoints, deleteGoal) —
// no new deletion logic, just wiring the same cleanup already
// proven correct elsewhere (see the earlier Qdrant orphan-data
// fix) into this mandatory compliance path.
//
// Idempotent and safe to run more than once (e.g. a redelivered
// webhook): deleting an already-empty shop's data is a no-op.
// =========================================================

const redactShop = async (req, res) => {
  try {
    const { shop } = req.body;

    if (!shop) {
      return res.status(400).json({
        success: false,
        message: "Shop is required"
      });
    }

    const matchKeys = (
      await Product.find({ shop }).select("matchKey").lean()
    ).map(product => product.matchKey);

    const deleteResult = await Product.deleteMany({ shop });

    if (matchKeys.length) {
      try {
        await deleteProductPoints(shop, matchKeys);
      } catch (qdrantError) {
        console.warn(
          "[SHOP REDACT] Could not remove Qdrant points (non-fatal, MongoDB already redacted):",
          qdrantError.message
        );
      }
    }

    const goalDeleted = await deleteGoal(shop);

    console.log("[SHOP REDACT] Complete", {
      shop,
      productsDeleted: deleteResult.deletedCount || 0,
      goalDeleted
    });

    return res.status(200).json({
      success: true,
      data: {
        productsDeleted: deleteResult.deletedCount || 0,
        goalDeleted
      }
    });
  } catch (error) {
    console.error("[SHOP REDACT] Failed:", error);

    return res.status(500).json({
      success: false,
      message: "Shop redact failed",
      error: error.message
    });
  }
};

module.exports = { redactShop };
