const express = require("express");

const {
  syncShopifyProducts
} = require("../controllers/product.controller");

const router = express.Router();

router.post(
  "/sync",
  syncShopifyProducts
);

module.exports = router;