const { getShopStatus, getGlobalStatus } = require("../services/status/status.service");
const { normalizeShop } = require("../services/goal/goal.service");

// =========================================================
// STATUS ENDPOINTS
// =========================================================
//
// GET /api/internal/status?shop=...   -> shop-scoped detail only (seller Dashboard)
// GET /api/internal/status/global     -> cross-shop overview (developer dashboard ONLY)
//
// Security fix: these used to be one endpoint that always
// returned the global, cross-shop overview (every shop's domain
// + product count, platform-wide totals) alongside whatever shop
// detail was requested — including to a regular merchant calling
// their own /api/status from their own authenticated session.
// Split into two routes so a normal merchant's request can never
// receive the global block at all, regardless of what parameters
// it sends. The seller-facing proxy (api.status.ts) only ever
// calls the shop-scoped route below; only the developer dashboard
// calls /global.
// =========================================================

const readShopStatus = async (req, res) => {
  try {
    const shop = normalizeShop(req.query.shop);

    if (!shop) {
      return res.status(400).json({
        success: false,
        message: "Shop is required"
      });
    }

    const shopStatus = await getShopStatus(shop);

    return res.status(200).json({
      success: true,
      data: {
        shop: shopStatus
      }
    });
  } catch (error) {
    console.error("[STATUS] Shop status failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load status"
    });
  }
};

const readGlobalStatus = async (req, res) => {
  try {
    const global = await getGlobalStatus();

    return res.status(200).json({
      success: true,
      data: {
        global
      }
    });
  } catch (error) {
    console.error("[STATUS] Global status failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load status"
    });
  }
};

module.exports = { readShopStatus, readGlobalStatus };
