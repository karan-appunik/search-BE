const express = require("express");

const { internalAuth } = require("../middleware/internal-auth");
const { readShopStatus, readGlobalStatus } = require("../controllers/status.controller");

const router = express.Router();

// =========================================================
// INTERNAL ONLY — same shared-secret auth as the goal routes.
//
// Both routes require the same secret, but only the developer
// dashboard is expected to ever call /global — the seller-facing
// proxy (api.status.ts) never does. See status.controller.js for
// why this used to be a single endpoint and why it was split.
// =========================================================

router.use(internalAuth);

router.get("/", readShopStatus);
router.get("/global", readGlobalStatus);

module.exports = router;
