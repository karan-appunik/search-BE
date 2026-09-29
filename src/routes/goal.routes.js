const express = require("express");

const {
  internalAuth
} = require("../middleware/internal-auth");

const {
  readGoal,
  saveGoal,
  removeGoal
} = require("../controllers/goal.controller");

const {
  listProducts
} = require("../controllers/goal-products.controller");


const router = express.Router();


// =========================================================
// INTERNAL ONLY
// =========================================================
//
// These endpoints are called by the authenticated Shopify app
// route, which resolves the shop from session.shop.
//
// They are never exposed to the storefront.
// =========================================================

router.use(internalAuth);


router.get(
  "/",
  readGoal
);


/*
 * Read-only product listing for the admin Goal picker UI.
 *
 * Placed before the "/" routes only for readability; Express
 * matches "/products" as a distinct literal path regardless of
 * declaration order relative to "/".
 */
router.get(
  "/products",
  listProducts
);


/*
 * PUT covers create AND update.
 *
 * Only one goal may exist per shop, so separate create/update
 * verbs would only invite a double-create bug.
 */
router.put(
  "/",
  saveGoal
);


router.delete(
  "/",
  removeGoal
);


module.exports = router;
