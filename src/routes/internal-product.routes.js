const express = require("express");

const {
  syncProducts
} = require(
  "../controllers/internal-product.controller"
);

const router = express.Router();

router.post(
  "/products/sync",
  syncProducts
);

module.exports = router;