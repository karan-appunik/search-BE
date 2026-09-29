const Product = require("../models/Product");

// =========================================================
// WEBHOOK: INVENTORY / AVAILABILITY UPDATE
// =========================================================
//
// The inventory_levels/update webhook payload only ever carries
// an inventory_item_id and an available quantity — no variant or
// product ID — so this looks the variant up by
// shopifyInventoryItemId (see Product.js) instead.
//
// No Qdrant write here: Qdrant's stored payload never included
// availability/stock (only shop, sku, matchKey, ids, title — see
// qdrant.service.js's upsertProducts), so availability has always
// been purely a MongoDB concern, checked at search/hydration time.
//
// Known simplification: `available > 0` is used as a stand-in for
// Shopify's real availableForSale, which also accounts for a
// variant's "continue selling when out of stock" policy — this
// webhook payload doesn't carry that policy. A variant configured
// to keep selling at zero stock will be (incorrectly) marked
// unavailable here. Flagged as a known edge case, not silently
// assumed correct.
// =========================================================

const webhookUpdateInventory = async (req, res) => {

  try {

    const { shop, shopifyInventoryItemId, available } = req.body;

    if (!shop) {
      return res.status(400).json({ success: false, message: "Shop is required" });
    }

    if (!shopifyInventoryItemId) {
      return res.status(400).json({ success: false, message: "shopifyInventoryItemId is required" });
    }

    const availableNumber = Number(available);
    const quantity = Number.isFinite(availableNumber) ? availableNumber : 0;

    const result = await Product.updateMany(
      { shop, shopifyInventoryItemId },
      {
        $set: {
          availableForSale: quantity > 0,
          inventoryQuantity: quantity
        }
      }
    );

    console.log("[INVENTORY WEBHOOK] Update", {
      shop,
      shopifyInventoryItemId,
      quantity,
      matched: result.matchedCount || 0,
      modified: result.modifiedCount || 0
    });

    return res.status(200).json({
      success: true,
      message: "Inventory webhook processed",
      data: {
        matched: result.matchedCount || 0,
        modified: result.modifiedCount || 0
      }
    });

  } catch (error) {

    console.error("[INVENTORY WEBHOOK] Update error:", error);

    return res.status(500).json({
      success: false,
      message: "Inventory webhook update failed",
      error: error.message
    });
  }
};

module.exports = {
  webhookUpdateInventory
};
