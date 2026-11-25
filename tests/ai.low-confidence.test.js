const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// =========================================================
// AI closest picks when nothing matches (no network: the
// provider call is replaced by a fake response).
//
// Before: picks scored below 50 were all discarded, the answer
// counted as "invalid", and search fell back to keyword ranking
// (e.g. jewelry for "something wintery vibes"). Now, when
// nothing reaches 50, the AI's own picks scored 20+ are kept
// as low-confidence alternatives. Normal answers are unchanged.
// =========================================================

process.env.OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "test-key";

const { recommendProducts } = require("../src/services/ai/ai.service");

const products = ["A", "B", "C", "D", "E", "F"].map(key => ({
  sku: key,
  matchKey: key,
  title: `Product ${key}`,
  availableForSale: true
}));

let lastRequest = null;
let nextAnswer = null;
let queryCounter = 0;

global.fetch = async (url, options) => {
  lastRequest = { url: String(url), body: JSON.parse(options.body) };

  return {
    ok: true,
    status: 200,
    json: async () => ({
      done_reason: "stop",
      message: { content: JSON.stringify(nextAnswer) }
    })
  };
};

// Each test uses a fresh query so the in-memory AI cache never
// answers instead of the fake provider.
async function ask(answer) {
  nextAnswer = answer;
  queryCounter += 1;

  return recommendProducts({
    shop: "test-shop.myshopify.com",
    query: `test query ${queryCounter}`,
    products
  });
}

beforeEach(() => {
  lastRequest = null;
});

test("only low scores: the AI's closest picks are kept as low-confidence alternatives", async () => {
  const result = await ask({
    intent: "product_search",
    resultType: "alternative",
    recommendations: [
      { sku: "A", score: 40 },
      { sku: "B", score: 38 },
      { sku: "C", score: 36 },
      { sku: "D", score: 30 },
      { sku: "E", score: 28 }
    ]
  });

  assert.equal(result.resultType, "alternative");
  assert.equal(result.lowConfidence, true);
  assert.deepEqual(result.recommendations.map(item => item.sku), ["A", "B", "C", "D"]);
});

test("low scores labelled direct by the AI are still treated as alternatives", async () => {
  const result = await ask({
    intent: "product_search",
    resultType: "direct",
    recommendations: [{ sku: "B", score: 25 }, { sku: "A", score: 45 }]
  });

  assert.equal(result.resultType, "alternative");
  assert.equal(result.lowConfidence, true);
  assert.deepEqual(result.recommendations.map(item => item.sku), ["A", "B"]);
});

test("a confident answer is unchanged: picks below 50 are still dropped, no low-confidence flag", async () => {
  const result = await ask({
    intent: "product_search",
    resultType: "direct",
    recommendations: [{ sku: "A", score: 92 }, { sku: "B", score: 30 }]
  });

  assert.equal(result.resultType, "direct");
  assert.equal(result.lowConfidence, undefined);
  assert.deepEqual(result.recommendations.map(item => item.sku), ["A"]);
});

test("picks below 20 are not kept: answer stays invalid (search falls back as before)", async () => {
  const result = await ask({
    intent: "product_search",
    resultType: "alternative",
    recommendations: [{ sku: "A", score: 15 }, { sku: "B", score: 5 }]
  });

  assert.equal(result.resultType, "invalid");
  assert.deepEqual(result.recommendations, []);
});

test("SKUs not in the catalog are still never returned", async () => {
  const result = await ask({
    intent: "product_search",
    resultType: "alternative",
    recommendations: [{ sku: "NOT-IN-CATALOG", score: 45 }, { sku: "C", score: 22 }]
  });

  assert.deepEqual(result.recommendations.map(item => item.sku), ["C"]);
  assert.equal(result.lowConfidence, true);
});

test("an explicit no_match is unchanged", async () => {
  const result = await ask({ intent: "no_match", resultType: "none", recommendations: [] });

  assert.equal(result.resultType, "none");
  assert.equal(result.lowConfidence, undefined);
});

test("the search prompt asks for the closest catalog products instead of no_match", async () => {
  await ask({ intent: "product_search", resultType: "direct", recommendations: [{ sku: "A", score: 90 }] });

  const system = lastRequest.body.messages.find(message => message.role === "system").content;

  assert.match(system, /do not return no_match/i);
  assert.match(system, /3 or 4 catalog products closest/);
  assert.match(system, /scores from 20 to 49/);
});
