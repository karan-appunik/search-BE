const express = require("express");

const {
  internalAuth
} = require("../middleware/internal-auth");

const {
  syncProductsAndRefreshVectors,
  webhookUpsertProduct,
  webhookDeleteProduct
} = require(
  "../controllers/internal-product.controller"
);

const router = express.Router();

router.post(
  "/products/sync",
  internalAuth,
  syncProductsAndRefreshVectors
);

router.post(
  "/products/webhook-upsert",
  internalAuth,
  webhookUpsertProduct
);

router.post(
  "/products/webhook-delete",
  internalAuth,
  webhookDeleteProduct
);

module.exports = router;
