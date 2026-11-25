const crypto = require("crypto");
const mongoose = require("mongoose");

const AiAnswerCache = require("../../models/AiAnswerCache");


// =========================================================
// PERSISTENT AI ANSWER CACHE
// =========================================================
//
// Second level behind the in-memory cache in ai.service.js, so
// repeated searches (and the merchant's Search questions) stay
// fast after a restart or deploy.
//
// It can never slow a search down or break it:
//   - skipped entirely when MongoDB isn't connected (no
//     buffering), and a read gives up after READ_TIMEOUT_MS;
//   - writes and clears are fire-and-forget;
//   - any error is treated as a cache miss.
// =========================================================

// Same answer for 24 hours, unless the shop's products change.
const TTL_MS = 24 * 60 * 60 * 1000;

const READ_TIMEOUT_MS = 250;


function isConnected() {
  return mongoose.connection?.readyState === 1;
}

function hashKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

function cleanShop(shop) {
  return String(shop || "").trim().toLowerCase();
}


/*
 * The stored answer for this cache key, or null (miss, expired,
 * slow, not connected, or any error).
 */
async function getStoredAnswer(key) {

  if (!isConnected()) {
    return null;
  }

  let timer;

  try {
    const lookup = AiAnswerCache.findOne({
      keyHash: hashKey(key),
      // TTL cleanup runs about once a minute; don't serve stragglers.
      expiresAt: { $gt: new Date() }
    })
      .select("value")
      .lean();

    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
    });

    const entry = await Promise.race([lookup, timeout]);

    return entry?.value || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}


function storeAnswer(key, shop, value) {

  const shopKey = cleanShop(shop);

  if (!isConnected() || !shopKey || !value) {
    return;
  }

  AiAnswerCache.updateOne(
    { keyHash: hashKey(key) },
    {
      $set: {
        shop: shopKey,
        value,
        expiresAt: new Date(Date.now() + TTL_MS)
      }
    },
    { upsert: true }
  ).catch(error => {
    console.warn(
      "[AI ANSWER CACHE] Could not store answer:",
      error?.message || error
    );
  });
}


/*
 * Forget a shop's stored answers (its products changed, or its
 * data is being deleted). Fire-and-forget unless awaited.
 */
function clearShopAnswers(shop) {

  const shopKey = cleanShop(shop);

  if (!isConnected() || !shopKey) {
    return Promise.resolve(0);
  }

  return AiAnswerCache.deleteMany({ shop: shopKey })
    .then(result => result.deletedCount || 0)
    .catch(error => {
      console.warn(
        "[AI ANSWER CACHE] Could not clear shop answers:",
        error?.message || error
      );

      return 0;
    });
}


module.exports = {
  getStoredAnswer,
  storeAnswer,
  clearShopAnswers
};
