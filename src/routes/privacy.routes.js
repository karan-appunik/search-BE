const express = require("express");

const { internalAuth } = require("../middleware/internal-auth");
const { redactShop } = require("../controllers/privacy.controller");

const router = express.Router();

// Same shared-secret protection as every other internal write
// endpoint (goal, webhook-upsert, etc.) — see internal-auth.js.
router.use(internalAuth);

router.post("/shop-redact", redactShop);

module.exports = router;
