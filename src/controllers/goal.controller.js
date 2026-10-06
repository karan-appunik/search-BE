const {
  normalizeShop,
  normalizeSkus,
  normalizeProducts,
  findUnknownSkus,
  getGoal,
  upsertGoal,
  deleteGoal
} = require("../services/goal/goal.service");

const {
  RULE_TYPES
} = require("../services/rules/rule-application.service");


const NAME_MAX_LENGTH = 120;


// =========================================================
// GET GOAL
// =========================================================
//
// GET /api/internal/goal?shop=...
// =========================================================

const readGoal = async (
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


    const goal =
      await getGoal(shop);


    return res.status(200).json({

      success: true,

      data:
        goal || null

    });


  } catch (error) {

    console.error(
      "[GOAL] Read failed:",
      error
    );


    return res.status(500).json({

      success: false,

      message:
        "Unable to load goal"

    });
  }
};


// =========================================================
// CREATE / UPDATE GOAL
// =========================================================
//
// PUT /api/internal/goal
//
// A single upsert handles both cases, because only one goal
// may ever exist per shop.
// =========================================================

const saveGoal = async (
  req,
  res
) => {

  try {

    const {
      shop: rawShop,
      name: rawName,
      skus: rawSkus,
      products: rawProducts,
      enabled,
      ruleType: rawRuleType
    } = req.body || {};


    /*
     * -----------------------------------------------------
     * VALIDATION
     * -----------------------------------------------------
     */

    const shop =
      normalizeShop(rawShop);


    if (!shop) {

      return res.status(400).json({

        success: false,

        message:
          "Shop is required"

      });
    }


    const name =
      String(
        rawName || ""
      ).trim();


    if (!name) {

      return res.status(400).json({

        success: false,

        message:
          "Goal name is required"

      });
    }


    if (
      name.length >
      NAME_MAX_LENGTH
    ) {

      return res.status(400).json({

        success: false,

        message:
          `Goal name must be ${NAME_MAX_LENGTH} characters or fewer`

      });
    }


    if (
      rawSkus !== undefined &&
      !Array.isArray(rawSkus)
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Selected products (skus) must be an array"

      });
    }


    if (
      rawProducts !== undefined &&
      !Array.isArray(rawProducts)
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Products must be an array"

      });
    }


    if (
      enabled !== undefined &&
      typeof enabled !== "boolean"
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Enabled must be a boolean"

      });
    }


    /*
     * undefined leaves the stored rule type unchanged; null or
     * "" clears it.
     */
    let ruleType;

    if (
      rawRuleType === null ||
      rawRuleType === ""
    ) {

      ruleType = null;

    } else if (
      rawRuleType !== undefined
    ) {

      ruleType =
        String(rawRuleType)
          .trim()
          .toLowerCase();


      if (
        !RULE_TYPES.includes(ruleType)
      ) {

        return res.status(400).json({

          success: false,

          message:
            `Rule type must be one of: ${RULE_TYPES.join(", ")}`

        });
      }
    }


    /*
     * Duplicates are removed rather than rejected. The merchant
     * selecting the same product twice is not an error, and the
     * stored ordering stays the one they chose.
     */
    const skus =
      normalizeSkus(rawSkus);


    /*
     * -----------------------------------------------------
     * SKU OWNERSHIP
     * -----------------------------------------------------
     *
     * Every SKU must exist in THIS shop's synced catalog.
     *
     * A SKU that belongs to another shop, or that was never
     * synced, is rejected instead of being silently stored:
     * it could never be promoted anyway.
     */
    const unknownSkus =
      await findUnknownSkus({
        shop,
        skus
      });


    if (
      unknownSkus.length
    ) {

      console.warn(
        "[GOAL] Rejected unknown SKUs",
        {
          shop,

          unknown:
            unknownSkus.length
        }
      );


      return res.status(400).json({

        success: false,

        message:
          "Some selected products do not belong to this shop's catalog",

        data: {
          invalidSkus:
            unknownSkus
        }

      });
    }


    const products =
      normalizeProducts(
        rawProducts,
        skus
      );


    /*
     * -----------------------------------------------------
     * UPSERT
     * -----------------------------------------------------
     */

    const goal =
      await upsertGoal({
        shop,
        name,
        skus,
        products,
        enabled,
        ruleType
      });


    console.log(
      "[GOAL] Saved",
      {
        shop,

        name,

        ruleType:
          goal?.ruleType || null,

        skus:
          skus.length,

        products:
          products.length
      }
    );


    return res.status(200).json({

      success: true,

      data: goal

    });


  } catch (error) {

    /*
     * The unique { shop } index rejected a concurrent insert.
     *
     * This is a conflict, not a server failure.
     */
    if (
      error?.code === 11000
    ) {

      console.warn(
        "[GOAL] Duplicate goal rejected by unique index"
      );


      return res.status(409).json({

        success: false,

        message:
          "A goal already exists for this shop"

      });
    }


    if (
      error?.name ===
      "ValidationError"
    ) {

      return res.status(400).json({

        success: false,

        message:
          error.message

      });
    }


    console.error(
      "[GOAL] Save failed:",
      error
    );


    return res.status(500).json({

      success: false,

      message:
        "Unable to save goal"

    });
  }
};


// =========================================================
// DELETE GOAL
// =========================================================
//
// DELETE /api/internal/goal
// =========================================================

const removeGoal = async (
  req,
  res
) => {

  try {

    const shop =
      normalizeShop(
        req.body?.shop ||
        req.query?.shop
      );


    if (!shop) {

      return res.status(400).json({

        success: false,

        message:
          "Shop is required"

      });
    }


    const deleted =
      await deleteGoal(shop);


    console.log(
      "[GOAL] Delete",
      {
        shop,
        deleted
      }
    );


    return res.status(200).json({

      success: true,

      deleted

    });


  } catch (error) {

    console.error(
      "[GOAL] Delete failed:",
      error
    );


    return res.status(500).json({

      success: false,

      message:
        "Unable to delete goal"

    });
  }
};


module.exports = {
  readGoal,
  saveGoal,
  removeGoal
};
