const {
  syncProducts
} = require("../services/shopify/product-sync.service");

const syncShopifyProducts = async (req, res) => {
  try {
    const shop =
      req.body.shop ||
      process.env.SHOPIFY_STORE_DOMAIN;

    if (!shop) {
      return res.status(400).json({
        success: false,
        message: "Shop is required"
      });
    }

    console.log("Starting Shopify product sync...");
    console.log("Shop:", shop);

    const result = await syncProducts({
      shop
    });

    console.log("Shopify product sync completed:", result);

    return res.status(200).json({
      success: true,
      message: "Products synced successfully",
      data: result
    });
  } catch (error) {
    console.error("=================================");
    console.error("PRODUCT SYNC ERROR");
    console.error("Message:", error.message);
    console.error("Stack:", error.stack);
    console.error("=================================");

    return res.status(500).json({
      success: false,
      message: "Product sync failed",

      // Temporary debugging information.
      // We will remove this later.
      error: error.message
    });
  }
};

module.exports = {
  syncShopifyProducts
};