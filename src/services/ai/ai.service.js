const provider =
  process.env.AI_PROVIDER || "ollama";

const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ||
  "https://ollama.com";

const OLLAMA_API_KEY =
  process.env.OLLAMA_API_KEY || "";

const GLM_NUM_PREDICT =
  Number(process.env.OLLAMA_NUM_PREDICT) > 0
    ? Number(process.env.OLLAMA_NUM_PREDICT)
    : 1536;

const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL ||
  "glm-5.3-flash:cloud";


// =========================================================
// OLLAMA URL
// =========================================================

function getOllamaChatUrl() {

  let base =
    String(
      OLLAMA_BASE_URL
    ).trim();

  base =
    base.replace(
      /\/+$/,
      ""
    );

  return `${base}/api/chat`;
}


// =========================================================
// TEXT NORMALIZATION
// =========================================================

function normalizeText(
  value
) {

  return String(
    value || ""
  )
    .toLowerCase()
    .replace(
      /\s+/g,
      " "
    )
    .trim();

}


// =========================================================
// GLM RESULT CACHE + IN-FLIGHT DEDUPLICATION
// =========================================================
// Keeps repeated preview queries from sending duplicate GLM calls.
// Cache is keyed by normalized query + supplied catalog SKUs.
// =========================================================

// Repeat searches (per shop + query + candidate set) reuse the
// AI answer for an hour; more entries so an hour of distinct
// searches isn't evicted early.
const GLM_CACHE_TTL_MS = 60 * 60 * 1000;
const GLM_CACHE_MAX = 500;

const glmCache = new Map();
const glmInFlight = new Map();

function getCatalogFingerprint(productCatalog) {

  return productCatalog
    .map(product => String(product?.sku || "").trim())
    .filter(Boolean)
    .sort()
    .join("|");

}

/*
 * The shop is part of the key: two shops can share a query and
 * even identical SKUs, and must never share a cached result.
 */
function getGLMCacheKey(shop, query, productCatalog) {

  return `${String(shop || "").trim().toLowerCase()}::${normalizeText(query)}::${getCatalogFingerprint(productCatalog)}`;

}

function getCachedGLMResult(key) {

  const entry = glmCache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() - entry.createdAt > GLM_CACHE_TTL_MS) {
    glmCache.delete(key);
    return null;
  }

  // LRU touch.
  glmCache.delete(key);
  glmCache.set(key, entry);

  console.log("[AI SERVICE] GLM cache hit");

  return entry.value;

}

function setCachedGLMResult(key, value) {

  glmCache.delete(key);
  glmCache.set(key, {
    createdAt: Date.now(),
    value
  });

  while (glmCache.size > GLM_CACHE_MAX) {
    const oldestKey = glmCache.keys().next().value;
    glmCache.delete(oldestKey);
  }

}


// =========================================================
// BUILD AI PRODUCT CATALOG
// =========================================================
//
// Keep the information that AI actually needs.
// Images, URLs and MongoDB internals are NOT sent.
// Variant information is preserved.
// =========================================================

function buildProductCatalog(
  products
) {

  return products

    .filter(
      product =>
        product &&
        product.sku &&
        product.title
    )

    .map(
      product => {

        const item = {

          sku:
            String(
              product.sku
            ).trim(),

          title:
            String(
              product.title ||
              ""
            ).trim(),

          description:
            String(
              product.description ||
              ""
            ).trim(),

          productType:
            String(
              product.productType ||
              ""
            ).trim(),

          vendor:
            String(
              product.vendor ||
              ""
            ).trim(),

          price:
            Number(
              product.price ||
              0
            ),

          currency:
            product.currency ||
            "USD",

          availableForSale:
            Boolean(
              product.availableForSale
            )

        };


        // ---------------------------------------------------
        // OPTIONAL PRODUCT DATA
        // ---------------------------------------------------

        if (
          Array.isArray(
            product.tags
          ) &&
          product.tags.length
        ) {

          item.tags =
            product.tags;

        }


        if (
          Array.isArray(
            product.ingredients
          ) &&
          product.ingredients.length
        ) {

          item.ingredients =
            product.ingredients;

        }


        if (
          Array.isArray(
            product.benefits
          ) &&
          product.benefits.length
        ) {

          item.benefits =
            product.benefits;

        }


        if (
          Array.isArray(
            product.features
          ) &&
          product.features.length
        ) {

          item.features =
            product.features;

        }


        // ---------------------------------------------------
        // VARIANT INFORMATION
        // ---------------------------------------------------

        if (
          product.variantTitle
        ) {

          item.variantTitle =
            String(
              product.variantTitle
            ).trim();

        }


        if (
          Array.isArray(
            product.variantOptions
          ) &&
          product.variantOptions.length
        ) {

          item.variantOptions =
            product.variantOptions;

        }


        if (
          product.barcode
        ) {

          item.barcode =
            String(
              product.barcode
            ).trim();

        }


        return item;

      }
    );

}


// =========================================================
// PREVIEW CATALOG
// =========================================================
//
// Preview requests run on every useful keystroke. Keep the model input
// compact so the model can spend its output budget on the required JSON.
// Final search keeps the richer catalog above.
// =========================================================

function buildPreviewCatalog(products) {
  return products
    .filter(product => product && product.sku && product.title)
    .map(product => ({
      sku: String(product.sku).trim(),
      title: String(product.title || "").trim(),
      description: String(product.description || "").trim().slice(0, 280),
      productType: String(product.productType || "").trim(),
      vendor: String(product.vendor || "").trim(),
      tags: Array.isArray(product.tags) ? product.tags.slice(0, 8) : [],
      ingredients: Array.isArray(product.ingredients) ? product.ingredients.slice(0, 8) : [],
      benefits: Array.isArray(product.benefits) ? product.benefits.slice(0, 8) : [],
      features: Array.isArray(product.features) ? product.features.slice(0, 8) : [],
      variantTitle: String(product.variantTitle || "").trim(),
      variantOptions: Array.isArray(product.variantOptions) ? product.variantOptions.slice(0, 8) : [],
      price: Number(product.price || 0),
      currency: product.currency || "USD",
      availableForSale: Boolean(product.availableForSale)
    }));
}


// =========================================================
// AI JSON PARSER
// =========================================================

function parseAIJson(
  text,
  productCatalog = []
) {

  if (
    typeof text !==
    "string"
  ) {

    throw new Error(
      "Ollama returned empty AI output"
    );

  }


  let cleaned =
    text.trim();


  /*
   * Remove accidental markdown fences.
   */

  cleaned =
    cleaned

      .replace(
        /^```json\s*/i,
        ""
      )

      .replace(
        /^```\s*/i,
        ""
      )

      .replace(
        /\s*```$/i,
        ""
      )

      .trim();


  /*
   * Normal JSON.
   */

  try {

    return JSON.parse(
      cleaned
    );

  } catch {
    // Continue with fallback.
  }


  /*
   * Extract a JSON object if the model
   * added a little surrounding text.
   */

  const start =
    cleaned.indexOf(
      "{"
    );

  const end =
    cleaned.lastIndexOf(
      "}"
    );


  if (
    start !== -1 &&
    end > start
  ) {

    try {

      return JSON.parse(
        cleaned.slice(
          start,
          end + 1
        )
      );

    } catch {
      // Continue with SKU recovery.
    }

  }


  /*
   * Recovery is intentionally strict.
   *
   * If Ollama stops because the output limit was reached, a JSON object
   * may be cut off after one or more complete recommendation objects.
   * Recover ONLY explicit SKU fields whose values exist in the supplied
   * catalog. Never recover arbitrary SKU-looking text.
   */

  const validSkus =
    new Set(
      productCatalog
        .map(
          product =>
            String(
              product?.sku ||
              ""
            ).trim()
        )
        .filter(Boolean)
    );


  const skuPatterns = [
    /["']sku["']\s*:\s*["']([A-Z0-9][A-Z0-9._-]{1,})["']/gi,
    /["']?sku["']?\s*[:=]\s*["']?([A-Z0-9][A-Z0-9._-]{1,})["']?/gi
  ];

  const recovered = [];

  function addRecoveredSku(value) {
    const sku = String(value || "").trim();
    if (!sku) return;

    const matchedSku = [...validSkus].find(
      validSku => validSku.toLowerCase() === sku.toLowerCase()
    );

    if (!matchedSku) return;
    if (recovered.some(item => item.sku === matchedSku)) return;

    recovered.push({
      sku: matchedSku,
      score: Math.max(50, 92 - recovered.length * 6),
      reason: "Relevant catalog match"
    });
  }

  for (const pattern of skuPatterns) {
    let match;
    while ((match = pattern.exec(cleaned)) !== null) {
      addRecoveredSku(match[1]);
      if (recovered.length >= 6) break;
    }
    if (recovered.length >= 6) break;
  }

  /*
   * Some truncated/poorly behaved JSON responses omit the `sku` key but
   * still contain an exact catalog title. Recovering only exact titles is
   * safe because the title must already exist in the supplied catalog.
   */
  if (recovered.length < 6) {
    const titleMatches = productCatalog
      .map(product => ({
        sku: String(product?.sku || "").trim(),
        title: String(product?.title || "").trim()
      }))
      .filter(item => item.sku && item.title && item.title.length >= 4)
      .sort((a, b) => b.title.length - a.title.length);

    for (const item of titleMatches) {
      if (cleaned.toLowerCase().includes(item.title.toLowerCase())) {
        addRecoveredSku(item.sku);
      }
      if (recovered.length >= 6) break;
    }
  }

  if (recovered.length) {
    console.warn(
      "[AI SERVICE] Recovered catalog matches from incomplete AI output:",
      recovered.map(item => item.sku)
    );

    return {
      intent: "product_search",
      resultType: "direct",
      recommendations: recovered
    };
  }

  // A preview request must never fail just because the model output
  // was truncated or not valid JSON. Treat it as no_match and let
  // the next keystroke issue a fresh query.
  console.warn(
    "[AI SERVICE] No valid AI recommendation output; returning no_match"
  );

  return {
    intent: "no_match",
    resultType: "invalid",
    recommendations: []
  };

}


// =========================================================
// MAIN AI SEARCH
// =========================================================

/*
 * Waits for a shared in-flight AI request. Each waiting search
 * counts as one waiter; when a search is cancelled it stops
 * waiting, and when no search is waiting any more the request
 * to the AI provider itself is cancelled.
 */
function waitForSharedRequest(entry, signal) {
  entry.waiters += 1;

  return new Promise((resolve, reject) => {
    let settled = false;

    const done = () => {
      if (settled) return false;
      settled = true;
      entry.waiters -= 1;
      if (signal) signal.removeEventListener("abort", onAbort);
      return true;
    };

    const onAbort = () => {
      if (!done()) return;

      if (entry.waiters <= 0) {
        entry.upstream.abort();
      }

      const error = new Error("AI request cancelled");
      error.name = "AbortError";
      reject(error);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    }

    entry.promise.then(
      value => { if (done()) resolve(value); },
      error => { if (done()) reject(error); }
    );
  });
}

const recommendProducts =
  async ({
    shop,
    signal = null,
    query,
    products,
    mode = "search"
  }) => {

    const cleanQuery =
      normalizeText(
        query
      );


    if (
      !cleanQuery
    ) {

      return {

        intent:
          "empty",

        recommendations:
          []

      };

    }


    if (
      !Array.isArray(
        products
      ) ||
      !products.length
    ) {

      return {

        intent:
          "no_products",

        recommendations:
          []

      };

    }


    const productCatalog =
      mode === "preview"
        ? buildPreviewCatalog(products)
        : buildProductCatalog(products);


    if (
      !productCatalog.length
    ) {

      return {

        intent:
          "no_products",

        recommendations:
          []

      };

    }


    const glmCacheKey =
      getGLMCacheKey(
        shop,
        cleanQuery,
        productCatalog
      );


    const cachedResult =
      getCachedGLMResult(
        glmCacheKey
      );


    if (cachedResult) {
      return cachedResult;
    }


    if (glmInFlight.has(glmCacheKey)) {

      console.log(
        "[AI SERVICE] Reusing in-flight AI request"
      );

      return waitForSharedRequest(
        glmInFlight.get(glmCacheKey),
        signal
      );

    }


    // Cancels the call to the AI provider (timeout, or every
    // waiting search was cancelled).
    const upstream =
      new AbortController();


    const runGLMRequest = async () => {

    console.log(
      `[AI SERVICE] ${provider} / ${OLLAMA_MODEL}: ${productCatalog.length} products for "${cleanQuery}"`
    );


// =======================================================
// PROMPT
// =======================================================

const SYSTEM_PROMPT = mode === "preview"
  ? `You are a general ecommerce product search engine.

Use ONLY the supplied catalog.
Understand the customer query using natural language, synonyms, paraphrases and incomplete phrases.
Return ONLY valid JSON. Never output reasoning, markdown or commentary.
Recommend only products that genuinely match the query. Never invent products or SKUs.
For a direct match use resultType "direct". If there is no exact/direct product but a genuinely useful alternative exists, use resultType "alternative". Use "none" only when neither exists.
Return at most 4 recommendations, ranked by relevance. Score 0-98, never 100.
Every SKU must exactly exist in the catalog.

Output exactly one JSON object:
{"intent":"product_search","resultType":"direct","recommendations":[{"sku":"EXACT_SKU","score":92}]}

No match:
{"intent":"no_match","resultType":"none","recommendations":[]}`
  : `You are a general ecommerce product search engine.

Use ONLY the supplied catalog.

Understand the customer's intent using natural language, synonyms, paraphrases, incomplete phrases, and partial queries.

Rules:
- Recommend only catalog products.
- Every SKU must exactly exist in the catalog.
- Never invent products, SKUs, attributes, specifications, variants, benefits, popularity or trends.
- Use title, description, productType, vendor, tags, ingredients, benefits, features, price, availability and variant data.
- Match all important requirements together.
- Respect category, color, size, brand, model, material, capacity, technical specifications, style, use case, budget and other available attributes.
- Respect exclusions such as not, without, avoid, except, instead of and rather than.
- Consider variant title, options, SKU, price and availability.
- For broad requests, return products only when genuinely relevant.
- For incomplete or partial queries, make the best useful recommendation from the supplied catalog using the information available so far.
- Do not require the customer to finish the sentence before recommending products.
- As the customer adds more words, improve the recommendations.
- Return no_match only when there is neither a direct match nor a genuinely useful alternative.
- Rank by absolute relevance.
- Score from 0 to 98. Never use 100.
- Return at most 6 recommendations.
- Set resultType to direct for direct matches and alternative only for useful alternatives.
- Return ONLY JSON.

Output exactly:
{"intent":"product_search","resultType":"direct","recommendations":[{"sku":"EXACT_SKU","score":92}]}

No match:
{"intent":"no_match","resultType":"none","recommendations":[]}`;

    // =======================================================
    // OLLAMA CLOUD REQUEST
    // =======================================================

    const ollamaUrl =
      getOllamaChatUrl();


    if (
      !OLLAMA_API_KEY
    ) {

      throw new Error(
        "OLLAMA_API_KEY is missing"
      );

    }




    const startedAt =
      Date.now();


    const controller =
      upstream;


    const timeout =
      setTimeout(
        () => {
          controller.abort();
        },
        30000
      );


    let response;


    try {

      response =
        await fetch(
          ollamaUrl,
          {

            method:
              "POST",

            headers: {

              "Content-Type":
                "application/json",

              Accept:
                "application/json",

              Authorization:
                `Bearer ${OLLAMA_API_KEY}`

            },


            body:
              JSON.stringify({

                model:
                  OLLAMA_MODEL,

                messages: [

                  {

                    role:
                      "system",

                    content:
                      SYSTEM_PROMPT

                  },

                  {

                    role:
                      "user",

                    content:
                      JSON.stringify({

                        customerQuery:
                          cleanQuery,

                        products:
                          productCatalog

                      })

                  }

                ],


                stream:
                  false,


                /*
                 * Ollama Cloud currently does not
                 * support JSON-schema structured output.
                 *
                 * JSON mode is supported.
                 */
                format:
                  "json",


                /*
                 * Disable thinking for this
                 * real-time product-search use case.
                 */
                think:
                  false,


                options: {

                  temperature:
                    0,

                  /*
                   * Preview output is intentionally compact:
                   * SKU + score only. This reduces latency and
                   * prevents JSON truncation on Ollama Cloud.
                   *
                   * Customer searches need more room: glm-5.3-flash
                   * writes hidden reasoning before its JSON (it
                   * ignores think:false), and at 512 tokens it was
                   * usually cut off, so JEV answered instead.
                   * Configurable via OLLAMA_NUM_PREDICT.
                   */
                  num_predict:
                    mode === "preview"
                      ? 160
                      : GLM_NUM_PREDICT

                }

              }),


            signal:
              controller.signal

          }
        );

    } finally {

      clearTimeout(
        timeout
      );

    }


    const elapsed =
      Date.now() -
      startedAt;


    console.log(
      `[AI SERVICE] Ollama response time: ${elapsed}ms`
    );


    if (
      !response.ok
    ) {

      const errorText =
        await response.text();


      console.error(
        "[AI SERVICE] Ollama HTTP error:",
        response.status,
        errorText
      );


      throw new Error(
        `Ollama request failed with status ${response.status}`
      );

    }
const data =
  await response.json();


console.log(
  "[AI SERVICE] Ollama done reason:",
  data?.done_reason
);


console.log(
  "[AI SERVICE] Ollama thinking tokens:",
  data?.message?.thinking
    ? data.message.thinking.length
    : 0
);


const rawOutput =
  data?.message?.content;

console.log(
  "[AI SERVICE] Ollama output length:",
  String(rawOutput || "").length
);

    if (
      !rawOutput
    ) {

      return {
        intent: "no_match",
        resultType: "invalid",
        failure: "empty_output",
        recommendations: []
      };

    }


    /*
     * The model ran out of tokens (num_predict) before finishing,
     * so whatever JSON it produced is cut off. Treat it as a
     * failed answer (search then uses JEV) rather than guessing
     * products out of partial text.
     */
    if (
      data?.done_reason === "length"
    ) {

      console.warn(
        "[AI SERVICE] GLM ran out of tokens before answering"
      );

      return {
        intent: "no_match",
        resultType: "invalid",
        failure: "token_limit",
        recommendations: []
      };

    }


    let result;


    try {

      result =
        parseAIJson(
          rawOutput,
          productCatalog
        );

    } catch (error) {

      console.error(
        "[AI SERVICE] Invalid AI JSON:",
        rawOutput
      );

      return {
        intent: "no_match",
        resultType: "invalid",
        failure: "invalid_json",
        recommendations: []
      };

    }


    // =======================================================
    // VERIFY AI SKUs AGAINST SUPPLIED CATALOG
    // =======================================================

    const validSkus =
      new Set(
        productCatalog.map(
          product =>
            product.sku
        )
      );


    const recommendations =
      Array.isArray(
        result?.recommendations
      )
        ? result.recommendations
        : [];


    const cleanedRecommendations =
      recommendations

        .filter(
          recommendation =>

            recommendation &&

            validSkus.has(
              String(
                recommendation.sku ||
                ""
              ).trim()
            )

        )

        .map(
          recommendation => {

            let score =
              Number(
                recommendation.score ??
                recommendation.relevanceScore
              );


            if (
              !Number.isFinite(
                score
              )
            ) {

              score =
                0;

            }


            score =
              Math.max(
                0,
                Math.min(
                  98,
                  Math.round(
                    score
                  )
                )
              );


            return {

              sku:
                String(
                  recommendation.sku
                ).trim(),

              score,

              reason:
                String(
                  recommendation.reason ||
                  "Relevant catalog match"
                ).trim()

            };

          }

        )

        .filter(
          recommendation =>
            recommendation.score >=
            50
        )

        .sort(
          (a, b) =>
            b.score -
            a.score
        )

        .slice(
          0,
          6
        );


    const finalResult = {

      intent:
        cleanedRecommendations.length
          ? (
            result?.intent ||
            "product_search"
          )
          : "no_match",

      resultType:
        cleanedRecommendations.length
          ? (
            result?.resultType === "alternative"
              ? "alternative"
              : "direct"
          )
          : (
            result?.resultType === "none"
              ? "none"
              : "invalid"
          ),

      recommendations:
        cleanedRecommendations

    };


    console.log(
      `[AI SERVICE] Result: ${finalResult.resultType}, ${finalResult.recommendations.length} recommendations`
    );


    // A failed answer is never cached: the next search for the
    // same query should try GLM again, not repeat the failure.
    if (
      finalResult.resultType !== "invalid"
    ) {
      setCachedGLMResult(
        glmCacheKey,
        finalResult
      );
    }


    return finalResult;

    };


    const requestPromise =
      runGLMRequest();

    const entry = {
      promise: requestPromise,
      upstream,
      waiters: 0
    };

    glmInFlight.set(
      glmCacheKey,
      entry
    );

    // A request every waiter abandoned still settles; never leave
    // its rejection unhandled.
    requestPromise.catch(() => {});

    try {
      return await waitForSharedRequest(entry, signal);
    } finally {
      requestPromise.finally(() => {
        if (
          glmInFlight.get(glmCacheKey) ===
          entry
        ) {
          glmInFlight.delete(glmCacheKey);
        }
      }).catch(() => {});
    }

  };


module.exports = {
  recommendProducts,
  getGLMCacheKey
};