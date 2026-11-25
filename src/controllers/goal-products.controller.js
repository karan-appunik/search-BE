const {
  normalizeShop
} = require("../services/goal/goal.service");

const {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clampInt,
  listGoalProducts,
  listProductTypes
} = require("../services/goal/goal-products.service");


// =========================================================
// LIST PRODUCTS FOR GOAL SELECTION
// =========================================================
//
// GET /api/internal/goal/products?shop=...&page=...&limit=...&search=...
//     optional: &sort=title_asc|title_desc|price_asc|price_desc
//               &inStock=1  &productType=...
//
// Read-only. Used by the admin Goal UI's product picker to
// browse/search the already-synced catalog. Does not touch
// search retrieval, vector search, or the AI/GLM pipeline.
// =========================================================

const listProducts = async (
  req,
  res
) => {

  try {

    const shop =
      normalizeShop(
        req.query.shop
      );


    if (!shop) {

      return res.status(400).json({

        success: false,

        message:
          "Shop is required"

      });
    }


    const pageResult =
      clampInt(
        req.query.page,
        {
          fallback: 1,
          min: 1,
          max: Number.MAX_SAFE_INTEGER
        }
      );


    if (!pageResult.valid) {

      return res.status(400).json({

        success: false,

        message:
          "Invalid page parameter"

      });
    }


    const limitResult =
      clampInt(
        req.query.limit,
        {
          fallback: DEFAULT_LIMIT,
          min: 1,
          max: MAX_LIMIT
        }
      );


    if (!limitResult.valid) {

      return res.status(400).json({

        success: false,

        message:
          "Invalid limit parameter"

      });
    }


    const search =
      req.query.search ||
      req.query.q ||
      "";


    // Optional sort / filters (absent = same list as before).
    const sort =
      String(req.query.sort || "");

    const inStock =
      req.query.inStock === "1" ||
      req.query.inStock === "true";

    const productType =
      String(req.query.productType || "");


    const [
      {
        products,
        page,
        limit,
        hasMore
      },
      productTypes
    ] =
      await Promise.all([
        listGoalProducts({
          shop,
          page:
            pageResult.value,
          limit:
            limitResult.value,
          search,
          sort,
          inStock,
          productType
        }),
        listProductTypes(shop, { inStock })
      ]);


    return res.status(200).json({

      success: true,

      data: {

        products,

        page,

        limit,

        hasMore,

        productTypes

      }

    });


  } catch (error) {

    console.error(
      "[GOAL PRODUCTS] List failed:",
      error
    );


    return res.status(500).json({

      success: false,

      message:
        "Unable to load products"

    });
  }
};


module.exports = {
  listProducts
};
