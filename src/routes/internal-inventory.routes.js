const express = require("express");

const {
  internalAuth
} = require("../middleware/internal-auth");

const {
  webhookUpdateInventory
} = require(
  "../controllers/internal-inventory.controller"
);

const router = express.Router();

router.post(
  "/webhook-update",
  internalAuth,
  webhookUpdateInventory
);

module.exports = router;
