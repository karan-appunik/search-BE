const Goal = require("../models/Goal");

// =========================================================
// GOAL REPOSITORY
// =========================================================
//
// All Mongoose access to the Goal collection lives here.
// goal.service.js contains the business rules (shop scoping,
// SKU ownership, normalization); this file only knows how to
// read/write a Goal document.
//
// There is intentionally no lookup by _id: a goal is always
// addressed by the shop that owns it, since shop is the
// tenant boundary and the unique index that enforces
// one-goal-per-shop is keyed on it.
// =========================================================

async function ensureIndexes() {
  await Goal.createIndexes();
}

async function findByShop(shop) {
  return Goal.findOne({ shop }).lean();
}

async function upsertByShop(shop, update) {
  return Goal.findOneAndUpdate(
    { shop },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();
}

async function deleteByShop(shop) {
  const result = await Goal.deleteOne({ shop });
  return (result?.deletedCount || 0) > 0;
}

/*
 * Used by the status endpoint (seller Dashboard + developer
 * Overview) to report goal presence without exposing the
 * goal's contents.
 */
async function countAll() {
  return Goal.countDocuments({});
}

async function findAllShopsWithGoals() {
  return Goal.find({}).select("shop name ruleType enabled updatedAt").lean();
}

module.exports = {
  ensureIndexes,
  findByShop,
  upsertByShop,
  deleteByShop,
  countAll,
  findAllShopsWithGoals
};
