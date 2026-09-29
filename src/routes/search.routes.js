const express = require("express");
const { search } = require("../controllers/search.controller");

const router = express.Router();

router.post("/", search);

module.exports = router;