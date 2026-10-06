const mongoose = require("mongoose");

const productRepository = require("../../repositories/product.repository");
const goalRepository = require("../../repositories/goal.repository");
const { getVectorIndexStatus } = require("../search/vector.service");

// =========================================================
// STATUS SERVICE
// =========================================================
//
// Aggregates real, read-only diagnostic data for two
// consumers:
//   - the seller Dashboard tab (shop-scoped)
//   - the developer dashboard (global, plus per-shop detail)
//
// Everything here is either a direct count/read from MongoDB
// (via the repositories) or a best-effort reachability check
// against an external service. Nothing is invented: a service
// this app cannot cheaply/safely probe is reported as
// "unknown", never as fake "healthy" data.
// =========================================================

const MONGO_STATES = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting"
};

function getMongoStatus() {
  const state = mongoose.connection?.readyState;

  return {
    state: MONGO_STATES[state] || "unknown",
    connected: state === 1
  };
}

/*
 * Best-effort reachability check for an Ollama endpoint
 * (local Qwen embeddings, or the cloud GLM chat API). Uses
 * GET /api/tags — the standard read-only Ollama endpoint for
 * listing available models — rather than triggering a real
 * embedding or chat generation call.
 *
 * A short timeout keeps this from blocking the whole status
 * response if an endpoint is slow/unreachable. On any failure
 * this reports "unknown" reachability rather than a confident
 * "down", since a timeout or network hiccup is not proof the
 * service is actually broken.
 */
async function checkOllamaReachable(baseUrl, apiKey) {
  if (!baseUrl) {
    return { configured: false, reachable: null };
  }

  try {
    const headers = {};

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(4000)
    });

    return { configured: true, reachable: response.ok };
  } catch (error) {
    return { configured: true, reachable: null, note: "unreachable or timed out" };
  }
}

// =========================================================
// SHOP-SCOPED STATUS
// =========================================================
//
// Used by the seller Dashboard tab: this shop's product/goal
// state plus the shared infrastructure checks.
// =========================================================

async function getShopStatus(shop) {
  const [products, goal, lastSyncedAt] = await Promise.all([
    productRepository.countAvailabilityByShop(shop),
    goalRepository.findByShop(shop),
    productRepository.getLastSyncedAt(shop)
  ]);

  return {
    shop,
    products,
    lastSyncedAt,
    goal: goal
      ? {
          name: goal.name,
          ruleType: goal.ruleType || null,
          selectedProductCount: Array.isArray(goal.skus) ? goal.skus.length : 0,
          enabled: goal.enabled,
          updatedAt: goal.updatedAt
        }
      : null
  };
}

// =========================================================
// GLOBAL STATUS
// =========================================================
//
// Used by the developer dashboard's Overview/System Health:
// infrastructure reachability plus totals across every shop.
// =========================================================

async function getGlobalStatus() {
  const [productsAllShops, goalCount, shops, vectorSearch, embeddingOllama, glmOllama] = await Promise.all([
    productRepository.countAllShops(),
    goalRepository.countAll(),
    productRepository.distinctShopsWithCounts(),
    getVectorIndexStatus(),
    checkOllamaReachable(process.env.OLLAMA_LOCAL_URL, null),
    checkOllamaReachable(process.env.OLLAMA_BASE_URL, process.env.OLLAMA_API_KEY)
  ]);

  return {
    mongo: getMongoStatus(),
    products: productsAllShops,
    goals: { total: goalCount },
    shops,
    vectorSearch,
    embeddingService: {
      model: process.env.OLLAMA_EMBEDDING_MODEL || null,
      ...embeddingOllama
    },
    llmService: {
      model: process.env.OLLAMA_MODEL || null,
      ...glmOllama
    }
  };
}

module.exports = {
  getShopStatus,
  getGlobalStatus
};
