    const Product =
      require("../../models/Product");

    const {
      recommendProducts
    } =
      require("../ai/ai.service");

    const {
      createEmbedding
    } =
      require("../ai/embedding.service");

    const {
      searchByVector
    } =
      require("./vector.service");

    const {
      getJevSelection,
      logJevShadowSelection,
      logJevVsGlmComparison,
      BOOST_RELEVANCE_MIN_SCORE
    } =
      require("../ai/jev.service");

    const {
      applyGoalRule,
      isApplicableGoal
    } =
      require("../rules/rule-application.service");

    const {
      getActiveGoal
    } =
      require("../goal/goal.service");


    // =========================================================
    // EMBEDDING / SEMANTIC CACHE
    // =========================================================
    //
    // Query embeddings are deterministic for the same model.
    // Keep a small in-memory cache so repeated/revisited queries
    // do not make Ollama run Qwen again. In-flight requests are
    // also shared so concurrent identical queries create only one
    // embedding request.
    //
    // This does NOT change ranking or AI behavior.
    // =========================================================

    const EMBEDDING_CACHE_TTL_MS = 5 * 60 * 1000;
    const EMBEDDING_CACHE_MAX = 200;

    // Vector cosine-similarity scores are used only for the second-stage
    // semantic fallback. Keep this configurable so the threshold can be
    // tuned from .env without changing the search code.
    const SEMANTIC_FALLBACK_MIN_SCORE = Number(
      process.env.SEMANTIC_FALLBACK_MIN_SCORE || "0.30"
    );

    console.log(
      "[SEARCH SERVICE] Semantic fallback minimum score:",
      SEMANTIC_FALLBACK_MIN_SCORE
    );

    const PRODUCT_FIELDS =
      [
        "shop",
        "sku",
        "matchKey",
        "shopifyProductId",
        "shopifyVariantId",
        "title",
        "variantTitle",
        "variantOptions",
        "barcode",
        "description",
        "productType",
        "vendor",
        "tags",
        "ingredients",
        "benefits",
        "features",
        "price",
        "compareAtPrice",
        "currency",
        "image",
        "images",
        "handle",
        "productUrl",
        "availableForSale",
        "inventoryQuantity"
      ].join(" ");

    const embeddingCache = new Map();
    const embeddingInFlight = new Map();

    function normalizeEmbeddingKey(query) {
      return String(query || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
    }

    function getCachedEmbedding(query) {
      const key = normalizeEmbeddingKey(query);
      const entry = embeddingCache.get(key);

      if (!entry) {
        return null;
      }

      if (Date.now() - entry.time > EMBEDDING_CACHE_TTL_MS) {
        embeddingCache.delete(key);
        return null;
      }

      // LRU touch.
      embeddingCache.delete(key);
      embeddingCache.set(key, entry);

      console.log("[EMBEDDING] Cache hit:", key);
      return entry.embedding;
    }

    function setCachedEmbedding(query, embedding) {
      const key = normalizeEmbeddingKey(query);

      embeddingCache.delete(key);
      embeddingCache.set(key, {
        embedding,
        time: Date.now()
      });

      while (embeddingCache.size > EMBEDDING_CACHE_MAX) {
        const oldestKey = embeddingCache.keys().next().value;
        if (oldestKey === undefined) break;
        embeddingCache.delete(oldestKey);
      }
    }

    async function getEmbedding(query) {
      const cached = getCachedEmbedding(query);
      if (cached) {
        return cached;
      }

      const key = normalizeEmbeddingKey(query);
      const existing = embeddingInFlight.get(key);

      if (existing) {
        console.log("[EMBEDDING] Reusing in-flight embedding:", key);
        return existing;
      }

      const promise = createEmbedding(query)
        .then(embedding => {
          if (Array.isArray(embedding) && embedding.length) {
            setCachedEmbedding(query, embedding);
          }
          return embedding;
        })
        .finally(() => {
          if (embeddingInFlight.get(key) === promise) {
            embeddingInFlight.delete(key);
          }
        });

      embeddingInFlight.set(key, promise);
      return promise;
    }


    // =========================================================
    // QUERY NORMALIZATION
    // =========================================================

    function normalizeQuery(
      query
    ) {

      return String(
        query || ""
      )
        .trim()
        .replace(
          /\s+/g,
          " "
        );

    }


    // =========================================================
    // GENERIC STOP WORDS
    // =========================================================

    const STOP_WORDS =
      new Set([

        "i",
        "me",
        "my",
        "mine",

        "you",
        "your",

        "we",
        "our",

        "want",
        "need",

        "give",
        "show",
        "find",
        "get",

        "please",

        "looking",
        "look",

        "a",
        "an",
        "the",

        "some",
        "something",
        "anything",

        "product",
        "products",
        "item",
        "items",

        "thing",
        "things",

        "with",
        "and",
        "or",

        "for",
        "to",
        "of",

        "is",
        "are",

        "this",
        "that",

        "in",
        "on",
        "at",

        "be",
        "have",
        "has",

        "do",
        "does",

        "very",
        "really",
        "just",

        "good",

        // Customer-intent phrasing (see conversationalStarts):
        // never part of a product title.
        "suggest",
        "recommend",
        "recommendation",
        "recommendations"

      ]);


    // =========================================================
    // BUILD LEXICAL QUERY
    // =========================================================
    //
    // Generic.
    // No product-specific vocabulary.
    // =========================================================

    function buildTextQuery(
      query
    ) {

      const words =
        normalizeQuery(
          query
        )
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);


      const meaningful =
        words.filter(
          word =>
            !STOP_WORDS.has(
              word
            ) &&
            word.length >= 2
        );


      /*
       * MongoDB's text index handles language
       * stemming itself, so don't aggressively
       * rewrite the user's words.
       */
      return meaningful.join(
        " "
      );

    }

    // =========================================================
    // FAST PARTIAL WORD SEARCH
    // =========================================================

    function escapeRegex(value) {
      return String(
        value || ""
      ).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );
    }


    async function findPrefixCandidates({
      shop,
      query,
      limit = 12
    }) {
      const cleanQuery =
        normalizeQuery(query)
          .toLowerCase()
          .trim();

      if (!cleanQuery) {
        return [];
      }

      /*
       * Generic prefix retrieval only. This gathers catalog evidence for
       * the AI; it does not decide which products are shown.
       */
      const regex =
        new RegExp(
          `^${escapeRegex(cleanQuery)}`,
          "i"
        );

      const candidates =
        await Product.find({
          shop,
          $or: [
            { title: regex },
            { productType: regex },
            { vendor: regex },
            { tags: regex },
            { variantTitle: regex },
            { variantOptions: regex }
          ]
        })
          .select(
            [
              "shop",
              "sku",
              "matchKey",
              "shopifyProductId",
              "shopifyVariantId",
              "title",
              "variantTitle",
              "variantOptions",
              "barcode",
              "description",
              "productType",
              "vendor",
              "tags",
              "ingredients",
              "benefits",
              "features",
              "price",
              "compareAtPrice",
              "currency",
              "image",
              "images",
              "handle",
              "productUrl",
              "availableForSale",
              "inventoryQuantity"
            ].join(" ")
          )
          .limit(Math.max(1, Math.min(24, limit)))
          .lean();

      return candidates;
    }

    // =========================================================
    // FAST PARTIAL WORD SEARCH
    // =========================================================

    function escapeRegex(
      value
    ) {
      return String(
        value || ""
      ).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );
    }


    async function findPartialCandidates({
      shop,
      query
    }) {
      const words =
        normalizeQuery(query)
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);

      const meaningful =
        words.filter(
          word =>
            !STOP_WORDS.has(word) &&
            word.length >= 2
        );

      if (!meaningful.length) {
        return [];
      }

      /*
       * Generic candidate retrieval only.
       * No product-specific categories or synonym rules.
       */
      const terms = meaningful.slice(-10);

      const regexes =
        terms.map(term => {
          const cleanTerm =
            String(term || "")
              .trim()
              .toLowerCase();

          const isPlural =
            cleanTerm.endsWith("s") &&
            !cleanTerm.endsWith("ss");

          const baseTerm =
            isPlural
              ? cleanTerm.slice(0, -1)
              : cleanTerm;

          const pluralPart =
            isPlural ? "s?" : "";

          return new RegExp(
            `(^|[\\s-])${escapeRegex(baseTerm)}${pluralPart}(?=$|[\\s-])`,
            "i"
          );
        });

      const candidates =
        await Product.find({
          shop,
          availableForSale: true,
          $or: [
            { title: { $in: regexes } },
            { productType: { $in: regexes } },
            { vendor: { $in: regexes } },
            { tags: { $in: regexes } },
            { variantTitle: { $in: regexes } },
            { variantOptions: { $in: regexes } },
            { description: { $in: regexes } },
            { ingredients: { $in: regexes } },
            { benefits: { $in: regexes } },
            { features: { $in: regexes } }
          ]
        })
          .select(
            [
              "shop",
              "sku",
              "matchKey",
              "shopifyProductId",
              "shopifyVariantId",
              "title",
              "variantTitle",
              "variantOptions",
              "barcode",
              "description",
              "productType",
              "vendor",
              "tags",
              "ingredients",
              "benefits",
              "features",
              "price",
              "compareAtPrice",
              "currency",
              "image",
              "images",
              "handle",
              "productUrl",
              "availableForSale",
              "inventoryQuantity"
            ].join(" ")
          )
          .limit(24)
          .lean();

      console.log(
        `[SEARCH SERVICE] Partial lexical candidates: ${candidates.length}` +
        (candidates.length ? ` | ${candidates.slice(0, 5).map(p => p?.title).join(", ")}` : "")
      );

      return candidates;
    }


    // =========================================================
    // BROAD QUERY
    // =========================================================

    function isBroadQuery(
      query
    ) {

      const text =
        normalizeQuery(
          query
        ).toLowerCase();


      const words =
        text
          .split(/\s+/)
          .filter(Boolean);


      const meaningful =
        words.filter(
          word =>
            !STOP_WORDS.has(
              word
            )
        );


      if (
        !meaningful.length
      ) {

        return true;

      }


      const vague =
        new Set([

          "general",
          "trendy",
          "trending",
          "popular",
          "nice",
          "best",
          "great",
          "premium",
          "stylish",
          "modern",
          "something",
          "anything"

        ]);


      return meaningful.every(
        word =>
          vague.has(
            word
          )
      );

    }

    // =========================================================
    // PARTIAL / INCOMPLETE QUERY
    // =========================================================

    function isPartialQuery(query) {
      const text =
        normalizeQuery(query)
          .toLowerCase();

      if (!text) {
        return true;
      }

      const conversationalStarts = [
        "i",
        "i want",
        "i need",
        "i'm looking",
        "im looking",
        "looking for",
        "show me",
        "give me",
        "suggest",
        "suggest me",
        "recommend",
        "recommend me",
        "need something",
        "want something"
      ];

      if (
        conversationalStarts.some(
          prefix =>
            text === prefix ||
            text.startsWith(prefix + " ")
        )
      ) {
        return true;
      }

      const words =
        text
          .split(/\s+/)
          .filter(Boolean);

      if (words.length >= 2) {
        const lastWord =
          words[words.length - 1];

        /*
         * Helps while the final word is still being typed:
         * "i want goo"
         * "looking for shu"
         * "show me lap"
         */
        if (
          lastWord.length <= 3
        ) {
          return true;
        }
      }

      return false;
    }

    // =========================================================
    // COMPLEX EXCLUSIONS
    // =========================================================

    function hasComplexNegation(
      query
    ) {

      const text =
        normalizeQuery(
          query
        ).toLowerCase();


      return (

        /\bnot\b/.test(text) ||

        /\bwithout\b/.test(text) ||

        /\bavoid\b/.test(text) ||

        /\bexcept\b/.test(text) ||

        /\binstead of\b/.test(text) ||

        /\brather than\b/.test(text) ||

        /\bdon't want\b/.test(text) ||

        /\bdont want\b/.test(text) ||

        /\bdo not want\b/.test(text)

      );

    }

    // =========================================================
    // SEMANTIC CANDIDATES
    // =========================================================
    //
    // Qwen converts the customer query into a vector.
    // Vector search (vector.service.js) finds semantically similar products.
    // MongoDB then loads the complete product records.
    //
    // If vector search is unavailable, return [] so the existing
    // lexical search can continue working.
    // =========================================================

    /*
     * The instant (JEV) and AI requests for the same search arrive
     * together; both need the same similarity search. Run it once
     * per shop + query (at the larger size) and share the result
     * for a few seconds.
     */
    const SEMANTIC_SHARE_MS = 15 * 1000;
    const SEMANTIC_SHARED_LIMIT = 30;
    const semanticShared = new Map();

    async function findSemanticCandidates({
      shop,
      query,
      limit = 16
    }) {
      const key = `${shop}::${String(query || "").trim().toLowerCase()}`;
      const size = Math.max(limit, SEMANTIC_SHARED_LIMIT);
      const existing = semanticShared.get(key);

      if (
        existing &&
        existing.size >= limit &&
        Date.now() - existing.startedAt < SEMANTIC_SHARE_MS
      ) {
        return (await existing.promise).slice(0, limit);
      }

      const entry = {
        startedAt: Date.now(),
        size,
        promise: runSemanticSearch({ shop, query, limit: size })
      };

      semanticShared.set(key, entry);

      // keep the map small: drop expired entries
      for (const [k, v] of semanticShared) {
        if (Date.now() - v.startedAt > SEMANTIC_SHARE_MS) {
          semanticShared.delete(k);
        }
      }

      return (await entry.promise).slice(0, limit);
    }

    async function runSemanticSearch({
      shop,
      query,
      limit = 16
    }) {
      try {

        const startedAt =
          Date.now();


        const embedding =
          await getEmbedding(
            query
          );


        if (
          !embedding.length
        ) {

          console.warn(
            "[SEARCH SERVICE] Empty query embedding"
          );

          return [];
        }


        const vectorResults =
          await searchByVector(
            embedding,
            {
              shop,
              limit
            }
          );


        const semanticPoints =
          vectorResults
            .map(point => ({
              sku: String(
                point?.payload?.matchKey ||
                point?.payload?.sku ||
                ""
              ).trim(),
              score: Number(point?.score)
            }))
            .filter(item => item.sku);

        const semanticScoreMap = new Map();

        for (const item of semanticPoints) {
          if (!semanticScoreMap.has(item.sku)) {
            semanticScoreMap.set(item.sku, item.score);
          }
        }

        const uniqueSkus =
          [...new Set(
            semanticPoints.map(item => item.sku)
          )];


        if (
          !uniqueSkus.length
        ) {

          console.log(
            "[SEARCH SERVICE] Semantic candidates: 0"
          );

          return [];
        }


        const products =
          await Product.find({
            shop,

            matchKey: {
              $in:
                uniqueSkus
            }
          })

            .select(
              [
                "shop",
                "sku",
                "matchKey",
                "shopifyProductId",
                "shopifyVariantId",
                "title",
                "variantTitle",
                "variantOptions",
                "barcode",
                "description",
                "productType",
                "vendor",
                "tags",
                "ingredients",
                "benefits",
                "features",
                "price",
                "compareAtPrice",
                "currency",
                "image",
                "images",
                "handle",
                "productUrl",
                "availableForSale",
                "inventoryQuantity"
              ].join(" ")
            )

            .lean();


        const productMap =
          new Map(
            products.map(
              product => [
                productKey(product),
                product
              ]
            )
          );


        /*
         * Keep vector similarity order.
         */
        const ordered =
          uniqueSkus
            .map(
              sku => {
                const product = productMap.get(sku);
                if (!product) return null;

                return {
                  ...product,
                  _semanticScore: semanticScoreMap.get(sku)
                };
              }
            )
            .filter(Boolean);


        console.log(
          `[SEARCH SERVICE] Semantic search: ${
            Date.now() -
            startedAt
          }ms`
        );


        console.log(
          `[SEARCH SERVICE] Semantic: ${ordered.length} candidates` +
          (ordered.length
            ? ` | top: ${ordered.slice(0, 5).map(p => `${p?.title} (${Number(p?._semanticScore).toFixed(2)})`).join(", ")}`
            : "")
        );


        return ordered;

      } catch (
        error
      ) {

        console.warn(
          "[SEARCH SERVICE] Semantic search unavailable:",
          error.message
        );


        /*
         * Important:
         *
         * Semantic search must never break
         * the existing AI search.
         */
        return [];
      }
    }
    // =========================================================
    // PRODUCT IDENTITY
    // =========================================================
    //
    // matchKey is the product's real SKU, or "variant:<gid>" when
    // the merchant never entered one. It is what vector search, goals and
    // the AI catalog key on; product.sku stays the display value.
    // Falls back to sku for documents synced before matchKey.
    // =========================================================

    function productKey(
      product
    ) {
      return String(
        product?.matchKey ||
        product?.sku ||
        ""
      ).trim();
    }


    // =========================================================
    // MERGE HYBRID CANDIDATES
    // =========================================================

    function mergeCandidates(
      lexicalCandidates,
      semanticCandidates,
      limit = 30
    ) {
      const merged =
        new Map();


      /*
       * Lexical candidates get priority first.
       */
      for (
        const product
        of lexicalCandidates || []
      ) {

        if (
          !productKey(product)
        ) {
          continue;
        }


        merged.set(
          productKey(product),
          product
        );
      }


      /*
       * Add semantic candidates that MongoDB
       * didn't already return.
       */
      for (
        const product
        of semanticCandidates || []
      ) {

        if (
          !productKey(product)
        ) {
          continue;
        }


        if (
          !merged.has(
            productKey(product)
          )
        ) {

          merged.set(
            productKey(product),
            product
          );
        }
      }


      return Array.from(
        merged.values()
      ).slice(
        0,
        limit
      );
    }
    // =========================================================
    // FAST MONGODB CANDIDATE SEARCH
    // =========================================================

    async function findCandidates({
      shop,
      query
    }) {
      const cleanQuery =
        normalizeQuery(query);


      /*
       * -------------------------------------------------------
       * PARTIAL / INCOMPLETE QUERY
       * -------------------------------------------------------
       *
       * Do NOT perform lexical filtering.
       * Give the AI the catalog so it can make
       * a best-effort recommendation.
       */
      if (
        isPartialQuery(
          cleanQuery
        )
      ) {

        console.log(
          "[SEARCH SERVICE] Partial query - using generic lexical candidates"
        );

        return findPartialCandidates({
          shop,
          query: cleanQuery
        });
      }


      /*
       * -------------------------------------------------------
       * BROAD QUERY
       * -------------------------------------------------------
       */
      if (
        isBroadQuery(
          cleanQuery
        )
      ) {

        console.log(
          "[SEARCH SERVICE] Broad query - using full catalog"
        );

        return null;
      }


      /*
       * -------------------------------------------------------
       * COMPLEX NEGATION
       * -------------------------------------------------------
       */
      if (
        hasComplexNegation(
          cleanQuery
        )
      ) {

        console.log(
          "[SEARCH SERVICE] Complex query - using full catalog"
        );

        return null;
      }


      /*
       * -------------------------------------------------------
       * VERY SHORT QUERY
       * -------------------------------------------------------
       */
      if (
        cleanQuery.length < 3
      ) {

        return null;
      }


      /*
       * -------------------------------------------------------
       * MONGODB TEXT SEARCH
       * -------------------------------------------------------
       */
      const startedAt =
        Date.now();


      const candidates =
        await Product.find({

          shop,

          $text: {
            $search:
              cleanQuery
          }

        })

          .select(
            [
              "shop",
              "sku",
              "matchKey",
              "shopifyProductId",
              "shopifyVariantId",
              "title",
              "variantTitle",
              "variantOptions",
              "barcode",
              "description",
              "productType",
              "vendor",
              "tags",
              "ingredients",
              "benefits",
              "features",
              "price",
              "compareAtPrice",
              "currency",
              "image",
              "images",
              "handle",
              "productUrl",
              "availableForSale",
              "inventoryQuantity"
            ].join(" ")
          )

          .sort({
            score: {
              $meta:
                "textScore"
            }
          })

          .limit(16)

          .lean();


      const elapsed =
        Date.now() -
        startedAt;


      console.log(
        `[SEARCH SERVICE] Mongo text search: ${elapsed}ms`
      );


      console.log(
        "[SEARCH SERVICE] Candidate count:",
        candidates.length
      );


      /*
       * -------------------------------------------------------
       * ACCURACY SAFEGUARD
       * -------------------------------------------------------
       *
       * If Mongo doesn't provide enough lexical evidence,
       * send the complete catalog to AI.
       */
      if (
        candidates.length < 4
      ) {

        console.log(
          "[SEARCH SERVICE] Insufficient candidates - full catalog fallback"
        );

        return null;
      }


      return candidates;
    }

    // =========================================================
    // COMPACT AI CATALOG
    // =========================================================

    function buildAICatalog(
      products
    ) {
      return products.map(
        product => {

          const item = {
            sku:
              productKey(product),

            title:
              product.title
          };


          if (
            product.variantTitle
          ) {
            item.variantTitle =
              product.variantTitle;
          }


          if (
            product.variantOptions
          ) {
            item.variantOptions =
              product.variantOptions;
          }


          if (
            product.description
          ) {
            item.description =
              product.description;
          }


          if (
            product.productType
          ) {
            item.productType =
              product.productType;
          }


          if (
            product.vendor
          ) {
            item.vendor =
              product.vendor;
          }


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


          if (
            product.barcode
          ) {
            item.barcode =
              product.barcode;
          }


          if (
            product.price !==
            undefined
          ) {
            item.price =
              product.price;
          }


          if (
            product.compareAtPrice !==
            null &&
            product.compareAtPrice !==
            undefined
          ) {
            item.compareAtPrice =
              product.compareAtPrice;
          }


          if (
            product.currency
          ) {
            item.currency =
              product.currency;
          }


          item.availableForSale =
            Boolean(
              product.availableForSale
            );


          if (
            product.inventoryQuantity !==
            undefined
          ) {
            item.inventoryQuantity =
              product.inventoryQuantity;
          }


          return item;
        }
      );
    }


    // =========================================================
    // UNAVAILABLE DIRECT MATCH -> AI ALTERNATIVES
    // =========================================================
    //
    // Availability is a product status, not a relevance filter.
    // If every direct AI-selected product is unavailable, ask the
    // same AI decision-maker to choose useful alternatives from the
    // same bounded candidate pool, excluding those direct SKUs.
    //
    // Never display raw semantic candidates as a fallback.
    // =========================================================

    function getMeaningfulQueryTokens(query) {
      return [
        ...new Set(
          normalizeQuery(query)
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, " ")
            .split(/\s+/)
            .map(word => word.trim())
            .filter(Boolean)
            .filter(word => !STOP_WORDS.has(word))
            .filter(word => word.length > 1)
        )
      ];
    }

    function normalizeMatchToken(word) {
      const token = String(word || "").toLowerCase().trim();

      if (token.length > 3 && token.endsWith("s")) {
        return token.slice(0, -1);
      }

      return token;
    }

    function hasStrongDirectMatch({ query, recommendations, candidates }) {
      const queryTokens = getMeaningfulQueryTokens(query)
        .map(normalizeMatchToken)
        .filter(Boolean);

      if (!queryTokens.length) {
        return false;
      }

      const candidateMap = new Map(
        (candidates || []).map(product => [
          productKey(product),
          product
        ])
      );

      return (recommendations || []).some(recommendation => {
        const sku = String(recommendation?.sku || "").trim();
        const product = candidateMap.get(sku);

        if (!product) {
          return false;
        }

        const titleTokens = new Set(
          String(product?.title || "")
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, " ")
            .split(/\s+/)
            .map(normalizeMatchToken)
            .filter(Boolean)
        );

        const matchedCount = queryTokens.filter(token =>
          titleTokens.has(token)
        ).length;

        const requiredMatches =
          queryTokens.length === 1
            ? 1
            : Math.max(2, Math.ceil(queryTokens.length * 0.6));

        return matchedCount >= requiredMatches;
      });
    }

    async function resolveUnavailableDirectMatch({
      shop,
      query,
      candidates,
      semanticCandidates,
      lexicalCandidates,
      aiResult
    }) {
      const recommendations = Array.isArray(
        aiResult?.recommendations
      )
        ? aiResult.recommendations
        : [];

      const directSkus = recommendations
        .map(item => String(item?.sku || "").trim())
        .filter(Boolean);

      /*
       * A semantic/need-based query such as:
       *   "i want good cleanser for dry skin"
       * can legitimately return related products even when there is no
       * exact product-name match. Those results are normal search results,
       * not fallback alternatives, so they must NOT get the fallback message.
       *
       * We use a generic title-overlap check as evidence that the customer's
       * query had a concrete/direct catalog match. This contains no
       * product-category or domain-specific vocabulary. Qwen vector search remains
       * candidate generation only and does not decide this.
       */
      const directMatchCandidates = [
        ...(lexicalCandidates || []),
        ...(candidates || [])
      ];

      const hasDirectLexicalMatch = hasStrongDirectMatch({
        query,
        recommendations,
        candidates: directMatchCandidates
      });

      const directProducts = await Product.find({
        shop,
        matchKey: { $in: directSkus }
      })
        .select("sku matchKey availableForSale inventoryQuantity")
        .lean();

      const availabilityMap = new Map(
        directProducts.map(product => [
          productKey(product),
          Boolean(product.availableForSale)
        ])
      );

      // Keep a direct result if at least one selected direct product
      // is currently available.
      const availableDirect = directSkus.some(
        sku => availabilityMap.get(sku) === true
      );

      if (availableDirect) {
        return {
          ...aiResult,
          resultType: hasDirectLexicalMatch ? "direct" : "recommended"
        };
      }

      /*
       * If AI found products for a related/natural-language need but there
       * is no lexical evidence of a concrete direct match, keep the AI
       * recommendations as normal results. Do not label them as
       * "alternatives" merely because the availability flag says they are
       * unavailable.
       */
      if (!hasDirectLexicalMatch) {
        console.log(
          "[SEARCH SERVICE] Related semantic query; keeping AI result without alternative message"
        );
        return {
          ...aiResult,
          resultType: "recommended"
        };
      }

      console.log(
        "[SEARCH SERVICE] Direct AI matches unavailable; using semantic alternatives"
      );

      const excluded = new Set(directSkus);

      /*
       * IMPORTANT:
       *
       * The normal AI result remains the final decision for the customer's
       * requested product. Only when every selected direct match is
       * unavailable do we enter this fallback path.
       *
       * Qwen vector search is used here specifically to find semantically
       * similar alternatives. We do NOT ask the LLM to invent/rerank the
       * fallback list.
       */
      // Reuse the semantic candidates already retrieved for this request.
      // This avoids a second embedding/vector call and keeps preview fast.
      console.log(
        "[SEARCH SERVICE] Reusing semantic alternatives:",
        (semanticCandidates || []).length
      );

      const alternativeProducts = (semanticCandidates || [])
        .filter(product => {
          const key = productKey(product);
          return key && !excluded.has(key);
        })
        .slice(0, 6);

      if (!alternativeProducts.length) {
        console.log(
          "[SEARCH SERVICE] Semantic search found no alternative products"
        );

        return {
          intent: "no_match",
          resultType: "none",
          recommendations: []
        };
      }

      console.log(
        "[SEARCH SERVICE] Semantic alternatives:",
        alternativeProducts.map((product, index) => ({
          rank: index + 1,
          sku: product?.sku,
          title: product?.title,
          productType: product?.productType,
          availableForSale: Boolean(product?.availableForSale)
        }))
      );

      return {
        intent: "product_search",
        resultType: "alternative",
        message: "We didn't find exactly that, but you might like these",
        recommendations: alternativeProducts.map((product, index) => ({
          sku: productKey(product),
          score: Math.max(0, 90 - index * 5),
          reason: "Semantically similar alternative"
        }))
      };
    }

    // =========================================================
    // PREVIEW SEARCH
    // =========================================================
    //
    // Predictive search must be fast enough to run while the
    // customer is typing. Preview mode intentionally does NOT
    // call the LLM. It uses cheap prefix/lexical retrieval first,
    // then semantic retrieval only when needed.
    //
    // Final/submit search keeps the existing AI reranking flow.
    // =========================================================

    async function findPreviewCandidates({
      shop,
      query,
      limit = 30
    }) {
      const cleanQuery = normalizeQuery(query);

      if (!cleanQuery) {
        return [];
      }

      /*
       * Preview retrieval is only a candidate-generation step.
       * It must not decide what the customer means.
       * The AI model makes the final relevance decision.
       *
       * We therefore use cheap lexical/prefix retrieval together with
       * Qwen vector retrieval to produce a bounded candidate
       * set. No product-category or domain-specific rules are used here.
       */
      const prefixPromise = findPrefixCandidates({
        shop,
        query: cleanQuery,
        limit: Math.min(10, limit)
      });

      // Same as final search: keep the few genuine word matches
      // when the text index finds fewer than 4.
      const lexicalPromise = findCandidates({
        shop,
        query: cleanQuery
      }).then(result =>
        result || findPartialCandidates({ shop, query: cleanQuery })
      );

      const semanticPromise = findSemanticCandidates({
        shop,
        query: cleanQuery,
        limit: Math.min(18, limit)
      });

      const [
        prefixCandidates,
        lexicalCandidates,
        semanticCandidates
      ] = await Promise.all([
        prefixPromise,
        lexicalPromise,
        semanticPromise
      ]);

      const lexicalEvidence = mergeCandidates(
        prefixCandidates || [],
        lexicalCandidates || [],
        10
      );


      const merged = mergeCandidates(
        semanticCandidates || [],
        lexicalEvidence || [],
        Math.min(24, limit)
      );

      console.log(
        `[SEARCH SERVICE] Preview lexical: ${lexicalEvidence.length}` +
        (lexicalEvidence.length ? ` | ${lexicalEvidence.slice(0, 5).map(p => p?.title).join(", ")}` : "")
      );

      return {
        candidates: merged.slice(0, Math.min(24, limit)),
        lexicalCandidates: (lexicalEvidence || []).slice(0, 10),
        semanticCandidates: (semanticCandidates || []).slice(0, 18)
      };
    }

    // =========================================================
    // EXACT SKU SHORT-CIRCUIT
    // =========================================================
    //
    // A customer typing an exact SKU gets that product directly,
    // with no LLM call. Matches the real sku field only (never the
    // internal "variant:<gid>" matchKey fallback), case-insensitive,
    // shop-scoped and available only.
    // =========================================================

    async function findExactSkuMatch({
      shop,
      query
    }) {
      const value = String(query || "").trim();

      if (
        !shop ||
        !value ||
        /\s/.test(value) ||
        value.length > 64
      ) {
        return null;
      }

      return Product.findOne({
        shop,
        sku: new RegExp(`^${escapeRegex(value)}$`, "i"),
        availableForSale: true
      })
        .select(PRODUCT_FIELDS)
        .lean();
    }


    // =========================================================
    // TITLE / QUERY OVERLAP
    // =========================================================
    //
    // Generic evidence that the query names a concrete product
    // (used to label results "direct" vs "recommended"). No
    // domain vocabulary; intent words live in STOP_WORDS.
    // =========================================================

    function titleMatchesQuery(
      query,
      product
    ) {
      const queryTokens = getMeaningfulQueryTokens(query)
        .map(normalizeMatchToken)
        .filter(Boolean);

      if (!queryTokens.length) {
        return false;
      }

      const titleTokens = new Set(
        String(product?.title || "")
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, " ")
          .split(/\s+/)
          .map(normalizeMatchToken)
          .filter(Boolean)
      );

      const matchedCount = queryTokens.filter(token =>
        titleTokens.has(token)
      ).length;

      const requiredMatches =
        queryTokens.length === 1
          ? 1
          : Math.max(2, Math.ceil(queryTokens.length * 0.6));

      return matchedCount >= requiredMatches;
    }


    // =========================================================
    // MERCHANT RULES (GOAL) SUPPORT
    // =========================================================

    const RULE_RESULT_LIMIT = 6;

    /*
     * Boost targets the rule can inject: available, shop-scoped,
     * in the merchant's chosen order, capped at 6. Query-agnostic
     * on purpose; ensureBoostedProductsPresent decides relevance.
     */
    async function getForcedBoostCandidates({
      shop,
      goal
    }) {
      if (
        !goal ||
        goal.ruleType !== "boost" ||
        !Array.isArray(goal.skus) ||
        !goal.skus.length
      ) {
        return [];
      }

      const products = await Product.find({
        shop,
        matchKey: { $in: goal.skus },
        availableForSale: true
      })
        .select(PRODUCT_FIELDS)
        .lean();

      const order = new Map(goal.skus.map((key, index) => [key, index]));

      return products
        .sort((a, b) => order.get(productKey(a)) - order.get(productKey(b)))
        .slice(0, RULE_RESULT_LIMIT);
    }

    /*
     * Boost is authoritative only for RELEVANT products: a
     * semantic score at/above BOOST_RELEVANCE_MIN_SCORE, or a
     * literal lexical match. Relevant boosted products missing
     * from the ranked list are appended (applyGoalRule then moves
     * them to the front); irrelevant ones are removed from the
     * goal handed to applyGoalRule so they are never promoted.
     * Returns the same references for anything but an active
     * Boost rule.
     */
    function ensureBoostedProductsPresent({
      products,
      goal,
      forcedBoostCandidates,
      semanticCandidates,
      lexicalCandidates
    }) {
      if (
        !goal ||
        goal.enabled !== true ||
        goal.ruleType !== "boost"
      ) {
        return { products, goal };
      }

      const semanticScores = new Map();

      for (const candidate of semanticCandidates || []) {
        const score = Number(candidate?._semanticScore);
        const key = productKey(candidate);

        if (
          key &&
          Number.isFinite(score) &&
          score > (semanticScores.get(key) ?? -Infinity)
        ) {
          semanticScores.set(key, score);
        }
      }

      const lexicalKeys = new Set(
        (lexicalCandidates || []).map(productKey).filter(Boolean)
      );

      const isRelevant = key =>
        lexicalKeys.has(key) ||
        (semanticScores.get(key) ?? -Infinity) >= BOOST_RELEVANCE_MIN_SCORE;

      const adjustedGoal = {
        ...goal,
        skus: (goal.skus || []).filter(isRelevant)
      };

      const list = Array.isArray(products) ? products : [];
      const present = new Set(list.map(productKey));
      const toAdd = [];

      for (const candidate of forcedBoostCandidates || []) {
        const key = productKey(candidate);

        if (key && isRelevant(key) && !present.has(key)) {
          present.add(key);

          toAdd.push({
            ...candidate,
            recommendationScore: 98,
            recommendationReason: "Boosted by merchant rule"
          });
        }
      }

      if (!toAdd.length) {
        return { products, goal: adjustedGoal };
      }

      return {
        products: [...list, ...toAdd],
        goal: adjustedGoal
      };
    }

    /*
     * Result cap that keeps Demote honest: demoting a product that
     * was naturally visible must move it to the end, not push it
     * off the visible list. Boost/Exclude/no rule: a plain cap.
     */
    function applyDemoteVisibilityCap({
      naturalRankedProducts,
      ruleAppliedProducts,
      goal,
      limit = RULE_RESULT_LIMIT
    }) {
      const ruleApplied = Array.isArray(ruleAppliedProducts) ? ruleAppliedProducts : [];

      if (
        !isApplicableGoal(goal) ||
        goal.ruleType !== "demote"
      ) {
        return ruleApplied.slice(0, limit);
      }

      const demoted = new Set(goal.skus);

      const visibleDemoted = (naturalRankedProducts || [])
        .slice(0, limit)
        .filter(product => demoted.has(productKey(product)));

      const rest = ruleApplied
        .filter(product => !demoted.has(productKey(product)))
        .slice(0, limit);

      return [...rest, ...visibleDemoted];
    }

    /*
     * JEV narrows what GLM sees to candidates it scored as
     * relevant. It never drops a candidate it has no opinion on
     * (lexical-only, no semantic score) nor a forced-boost
     * candidate, and if it selects nothing GLM gets the full list.
     */
    function resolveJevCandidatesForGlm({
      candidates,
      forcedBoostCandidates
    }) {
      const list = Array.isArray(candidates) ? candidates : [];
      const jevSelection = getJevSelection(list);

      if (!jevSelection.selected.length) {
        return { candidatesForGlm: list, jevSelection };
      }

      const kept = list.filter(product => {
        const score = Number(product?._semanticScore);
        return !Number.isFinite(score) || score >= jevSelection.threshold;
      });

      const present = new Set(kept.map(productKey));

      for (const boosted of forcedBoostCandidates || []) {
        const key = productKey(boosted);

        if (key && !present.has(key)) {
          present.add(key);
          kept.push(boosted);
        }
      }

      return { candidatesForGlm: kept, jevSelection };
    }


    // =========================================================
    // PREVIEW RANKING (NO LLM)
    // =========================================================
    //
    // Preview runs while the customer types, so it ranks with the
    // signals retrieval already produced: lexical matches first,
    // then semantic matches by score. A candidate with neither
    // (e.g. a force-merged boosted product) is left out; boost
    // relevance is decided by ensureBoostedProductsPresent.
    // =========================================================

    function rankPreviewCandidatesWithoutGlm({
      query,
      candidates,
      lexicalCandidates
    }) {
      const list = Array.isArray(candidates) ? candidates : [];

      const lexicalKeys = new Set(
        (lexicalCandidates || []).map(productKey).filter(Boolean)
      );

      const lexical = [];
      const semantic = [];

      for (const product of list) {
        const key = productKey(product);
        const score = Number(product?._semanticScore);

        if (!key) {
          continue;
        }

        if (lexicalKeys.has(key)) {
          lexical.push({
            ...product,
            recommendationScore: 90,
            recommendationReason: "Matches your search"
          });
        } else if (Number.isFinite(score)) {
          semantic.push({
            ...product,
            recommendationScore: Math.max(0, Math.min(98, Math.round(score * 100))),
            recommendationReason: "Relevant catalog match"
          });
        }
      }

      semantic.sort((a, b) => b._semanticScore - a._semanticScore);

      /*
       * When the query literally matches products, a weak
       * semantic-only neighbour (e.g. a mug scoring 0.34 for
       * "jacket") is noise; only confident ones stay.
       */
      const products = [
        ...lexical,
        ...(lexical.length
          ? semantic.filter(product => product._semanticScore >= BOOST_RELEVANCE_MIN_SCORE)
          : semantic)
      ];

      /*
       * Without GLM, a list made only of weak semantic neighbours
       * (no word match, nothing at the "genuinely relevant" bar —
       * see BOOST_RELEVANCE_MIN_SCORE in jev.service.js) means the
       * catalog doesn't carry what was asked for: still show
       * them, but as alternatives, same as final search does.
       */
      const onlyWeakMatches =
        products.length > 0 &&
        !lexical.length &&
        semantic.every(product => product._semanticScore < BOOST_RELEVANCE_MIN_SCORE);

      let resultType = "recommended";

      if (products.some(product => titleMatchesQuery(query, product))) {
        resultType = "direct";
      } else if (onlyWeakMatches) {
        resultType = "alternative";
      }

      return {
        products,
        resultType
      };
    }


    // =========================================================
    // SEMANTIC FALLBACK WHEN GLM RETURNS NOTHING
    // =========================================================
    //
    // Shared by preview and final search. Candidates that clear
    // the similarity threshold replace an empty GLM result; they
    // are labelled "alternative" (with the fallback message) only
    // when none of them actually matches the query's words.
    // =========================================================

    const FALLBACK_MESSAGE =
      "We didn't find exactly that, but you might like these";

    /*
     * Labels a result after sold-out products were removed: if
     * only the removed ones actually matched the query's words,
     * what is left is an alternative, not a direct match.
     */
    function labelAvailableResult({
      query,
      available,
      soldOut,
      resultType,
      message
    }) {
      if (resultType === "alternative") {
        return { resultType, message: message || FALLBACK_MESSAGE };
      }

      if (available.some(product => titleMatchesQuery(query, product))) {
        return { resultType: "direct", message: "" };
      }

      if (soldOut.some(product => titleMatchesQuery(query, product))) {
        return { resultType: "alternative", message: FALLBACK_MESSAGE };
      }

      return {
        resultType: resultType === "direct" ? "recommended" : (resultType || "recommended"),
        message: ""
      };
    }

    function applySemanticFallbackIfNoRecommendations({
      query,
      aiResult,
      semanticCandidates
    }) {
      if (
        Array.isArray(aiResult?.recommendations) &&
        aiResult.recommendations.length
      ) {
        return aiResult;
      }

      const usable = (semanticCandidates || [])
        .filter(product => {
          const score = Number(product?._semanticScore);
          return productKey(product) &&
            Number.isFinite(score) &&
            score >= SEMANTIC_FALLBACK_MIN_SCORE;
        })
        .slice(0, RULE_RESULT_LIMIT);

      if (!usable.length) {
        return aiResult;
      }

      const recommendations = usable.map((product, index) => ({
        sku: productKey(product),
        score: Math.max(50, 90 - index * 5),
        reason: "Semantically similar alternative"
      }));

      if (
        query &&
        usable.some(product => titleMatchesQuery(query, product))
      ) {
        return {
          intent: "product_search",
          resultType: "recommended",
          recommendations: recommendations.map(item => ({
            ...item,
            reason: "Relevant catalog match"
          }))
        };
      }

      return {
        intent: "product_search",
        resultType: "alternative",
        message: FALLBACK_MESSAGE,
        recommendations
      };
    }


    // =========================================================
    // HYDRATE AI RECOMMENDATIONS
    // =========================================================
    //
    // Loads full product records for GLM's (or a fallback's)
    // recommendations, in recommendation order, dropping anything
    // not in this shop's catalog.
    // =========================================================

    async function hydrateRecommendations({
      shop,
      recommendations,
      minScore = 0
    }) {
      const keys = (recommendations || [])
        .map(item => String(item?.sku || "").trim())
        .filter(Boolean);

      if (!keys.length) {
        return [];
      }

      const products = await Product.find({
        shop,
        matchKey: { $in: keys }
      }).lean();

      const productMap = new Map(products.map(product => [productKey(product), product]));
      const seen = new Set();

      return recommendations
        .map(recommendation => {
          const key = String(recommendation?.sku || "").trim();
          const product = productMap.get(key);

          if (!product || seen.has(key)) {
            return null;
          }

          seen.add(key);

          let score = Number(recommendation.score ?? recommendation.relevanceScore);

          if (!Number.isFinite(score)) {
            score = 0;
          }

          return {
            ...product,
            recommendationScore: Math.max(0, Math.min(98, Math.round(score))),
            recommendationReason: String(
              recommendation.reason || "Relevant product match"
            ).trim()
          };
        })
        .filter(product => product && product.recommendationScore >= minScore);
    }


    // =========================================================
    // NOTHING IN STOCK MATCHED: SHOW SIMILAR AVAILABLE PRODUCTS
    // =========================================================
    //
    // Sold-out products are never shown. Instead of an empty
    // result, offer in-stock products with the alternative
    // message:
    //   1. the most similar ones retrieval already loaded for
    //      this query (no extra work), else
    //   2. a few in-stock products from one indexed query — only
    //      when retrieval had nothing usable (e.g. embeddings down).
    // Products the merchant's Exclude rule hides never appear.
    // =========================================================

    async function buildAlternativeResult({
      shop,
      query,
      candidates,
      goal,
      forcedBoostCandidates,
      semanticCandidates,
      lexicalCandidates
    }) {
      const excluded =
        isApplicableGoal(goal) && goal.ruleType === "exclude"
          ? [...new Set(goal.skus)]
          : [];

      const excludedSet = new Set(excluded);
      const seen = new Set();

      let alternatives = (candidates || [])
        .filter(product => {
          const key = productKey(product);

          if (
            !key ||
            seen.has(key) ||
            product.availableForSale !== true ||
            excludedSet.has(key)
          ) {
            return false;
          }

          seen.add(key);
          return true;
        })
        .slice(0, RULE_RESULT_LIMIT);

      if (!alternatives.length) {
        alternatives = await Product.find({
          shop,
          availableForSale: true,
          ...(excluded.length ? { matchKey: { $nin: excluded } } : {})
        })
          .select(PRODUCT_FIELDS)
          .limit(RULE_RESULT_LIMIT)
          .lean();
      }

      const products = applyMerchantRule({
        products: alternatives.map(product => ({
          ...product,
          recommendationScore: product.recommendationScore ?? 50,
          recommendationReason: "Similar available product"
        })),
        goal,
        forcedBoostCandidates,
        semanticCandidates,
        lexicalCandidates,
        limit: RULE_RESULT_LIMIT
      });

      if (!products.length) {
        return {
          query,
          intent: "no_match",
          resultType: "none",
          message: "",
          products: []
        };
      }

      return {
        query,
        intent: "product_search",
        resultType: "alternative",
        message: FALLBACK_MESSAGE,
        products
      };
    }


    // =========================================================
    // APPLY MERCHANT RULE
    // =========================================================
    //
    // Runs after ranking in both modes: boost relevance check,
    // then applyGoalRule, then the (demote-aware) cap.
    // =========================================================

    function applyMerchantRule({
      products,
      goal,
      forcedBoostCandidates,
      semanticCandidates,
      lexicalCandidates,
      limit
    }) {
      const {
        products: natural,
        goal: adjustedGoal
      } = ensureBoostedProductsPresent({
        products,
        goal,
        forcedBoostCandidates,
        semanticCandidates,
        lexicalCandidates
      });

      const ruleApplied = applyGoalRule({
        products: natural || [],
        goal: adjustedGoal
      });

      return applyDemoteVisibilityCap({
        naturalRankedProducts: natural || [],
        ruleAppliedProducts: ruleApplied,
        goal: adjustedGoal,
        limit
      });
    }


    // =========================================================
    // WHICH MODEL SERVED THE SEARCH (terminal log)
    // =========================================================
    //
    // GLM is always tried first. JEV only answers when GLM failed
    // (usage limit, token limit, invalid answer, any error) — or
    // when preview mode is requested explicitly.
    // =========================================================

    /*
     * Only the most relevant candidates go to the AI model (a
     * smaller prompt answers faster): title matches first, then
     * other word matches, then by semantic similarity. Sold-out
     * products (never shown to customers) and extra variants of
     * the same product are skipped, so all slots are distinct,
     * buyable options. JEV still ranks the full candidate list
     * if the AI model fails.
     */
    const AI_CANDIDATE_LIMIT = 12;

    function selectTopCandidatesForAI({
      query,
      candidates,
      lexicalCandidates,
      semanticCandidates,
      limit = AI_CANDIDATE_LIMIT
    }) {
      const lexicalKeys = new Set(
        (lexicalCandidates || []).map(productKey).filter(Boolean)
      );

      const semanticScores = new Map(
        (semanticCandidates || [])
          .filter(product => Number.isFinite(Number(product?._semanticScore)))
          .map(product => [productKey(product), Number(product._semanticScore)])
      );

      const rank = product => {
        const key = productKey(product);
        const tier =
          titleMatchesQuery(query, product) ? 0
            : lexicalKeys.has(key) ? 1
              : 2;
        return { product, tier, score: semanticScores.get(key) ?? -1 };
      };

      const seenProducts = new Set();

      return (candidates || [])
        .filter(product => product?.availableForSale === true)
        .map(rank)
        .sort((a, b) => a.tier - b.tier || b.score - a.score)
        .filter(({ product }) => {
          // one variant per Shopify product (best-ranked one)
          const productId = product.shopifyProductId || productKey(product);

          if (seenProducts.has(productId)) {
            return false;
          }

          seenProducts.add(productId);
          return true;
        })
        .slice(0, limit)
        .map(item => item.product);
    }


    function logModelResponse({
      servedBy,
      query,
      reason,
      result,
      instant = false
    }) {
      /*
       * "JEV MODEL RESPONSE" = the AI failed and JEV answered.
       * Instant results (preview mode, shown in the storefront
       * only until the AI answers) get their own label.
       */
      const label =
        instant
          ? "JEV INSTANT RESULTS (shown until AI answers)"
          : servedBy === "JEV"
            ? "JEV MODEL RESPONSE"
            : `AI MODEL (${process.env.OLLAMA_MODEL || "GLM"}) RESPONSE`;

      // Lets the storefront keep its instant results when the AI
      // failed instead of replacing them with the same JEV answer.
      if (result) {
        result.servedBy = servedBy === "JEV" ? "jev" : "ai";
      }

      console.log(
        `${label} "${query}"` +
        (reason ? ` (${reason})` : "") +
        ` -> ${result?.resultType || "none"}: ` +
        ((result?.products || []).map(product => product.title).join(", ") || "no products")
      );

      return result;
    }


    // =========================================================
    // MAIN SEARCH
    // =========================================================
    //
    //   1. exact SKU short-circuit
    //   2. active merchant rule + its boost targets
    //   3. retrieval (lexical + semantic), JEV narrowing
    //   4. ranking: preview = retrieval scores only (no LLM),
    //      final = GLM + availability + semantic fallback
    //   5. merchant rule (boost / exclude / demote) + cap
    // =========================================================

    const searchProducts =
      async ({
        shop,
        query,
        mode = "final",
        signal = null
      }) => {

        if (!shop) {
          throw new Error("Shop is required");
        }

        const startedAt = Date.now();
        const cleanQuery = normalizeQuery(query);
        const searchMode = mode === "preview" ? "preview" : "final";

        if (!cleanQuery) {
          return {
            query: "",
            intent: "empty",
            products: []
          };
        }

        const activeGoal = await getActiveGoal(shop);

        // -------------------------------------------------------
        // 1. EXACT SKU
        // -------------------------------------------------------

        const exactMatch = await findExactSkuMatch({
          shop,
          query: cleanQuery
        });

        if (exactMatch) {
          console.log("[SEARCH SERVICE] Exact SKU match:", exactMatch.sku);

          return {
            query: cleanQuery,
            intent: "product_search",
            resultType: "direct",
            message: "",
            products: applyGoalRule({
              products: [{
                ...exactMatch,
                recommendationScore: 98,
                recommendationReason: "Exact SKU match"
              }],
              goal: activeGoal
            })
          };
        }

        const forcedBoostCandidates = await getForcedBoostCandidates({
          shop,
          goal: activeGoal
        });

        // -------------------------------------------------------
        // 2. PREVIEW (no LLM)
        // -------------------------------------------------------

        /*
         * Nothing to search for yet (e.g. "i want", "show me"): the
         * AI can't recommend anything useful, so answer with JEV
         * and don't spend an AI call.
         */
        const aiSkipped =
          searchMode === "final" &&
          !getMeaningfulQueryTokens(cleanQuery).length;

        if (searchMode === "preview" || aiSkipped) {
          const previewReason = aiSkipped
            ? "no product words yet, AI skipped"
            : "preview mode";

          const {
            candidates,
            lexicalCandidates,
            semanticCandidates
          } = await findPreviewCandidates({
            shop,
            query: cleanQuery,
            limit: 24
          });

          const { candidatesForGlm } = resolveJevCandidatesForGlm({
            candidates: mergeCandidates(candidates, forcedBoostCandidates, 30),
            forcedBoostCandidates
          });

          const ranked = rankPreviewCandidatesWithoutGlm({
            query: cleanQuery,
            candidates: candidatesForGlm,
            lexicalCandidates
          });

          let products = ranked.products.filter(product => product.availableForSale);

          let {
            resultType,
            message
          } = labelAvailableResult({
            query: cleanQuery,
            available: products,
            soldOut: ranked.products.filter(product => !product.availableForSale),
            resultType: ranked.resultType,
            message: ""
          });

          // Nothing available matched: same semantic fallback
          // final search uses.
          if (!products.length) {
            const fallback = applySemanticFallbackIfNoRecommendations({
              query: cleanQuery,
              aiResult: { intent: "no_match", recommendations: [] },
              semanticCandidates: semanticCandidates.filter(product => product.availableForSale)
            });

            products = await hydrateRecommendations({
              shop,
              recommendations: fallback.recommendations
            });
            resultType = products.length ? fallback.resultType : "none";
            message = fallback.message || "";
          }

          products = applyMerchantRule({
            products,
            goal: activeGoal,
            forcedBoostCandidates,
            semanticCandidates,
            lexicalCandidates,
            limit: RULE_RESULT_LIMIT
          });

          console.log(`[SEARCH TIMING] PREVIEW TOTAL: ${Date.now() - startedAt}ms`);

          if (!products.length) {
            return logModelResponse({
              servedBy: "JEV",
              instant: !aiSkipped,
              query: cleanQuery,
              reason: previewReason,
              result: await buildAlternativeResult({
                shop,
                query: cleanQuery,
                // semantic first: they are ordered by similarity
                candidates: [...semanticCandidates, ...candidates],
                goal: activeGoal,
                forcedBoostCandidates,
                semanticCandidates,
                lexicalCandidates
              })
            });
          }

          return logModelResponse({
            servedBy: "JEV",
            instant: !aiSkipped,
            query: cleanQuery,
            reason: previewReason,
            result: {
              query: cleanQuery,
              intent: "product_search",
              resultType,
              message,
              products
            }
          });
        }

        // -------------------------------------------------------
        // 3. FINAL (GLM)
        // -------------------------------------------------------

        const [
          lexicalCandidates,
          semanticCandidates
        ] = await Promise.all([
          /*
           * findCandidates returns null when the text index finds
           * fewer than 4 products; the regex word search still
           * keeps those genuine matches instead of dropping them.
           */
          findCandidates({ shop, query: cleanQuery }).then(result =>
            result || findPartialCandidates({ shop, query: cleanQuery })
          ),
          findSemanticCandidates({ shop, query: cleanQuery, limit: 30 })
        ]);

        const retrieved = mergeCandidates(
          mergeCandidates(lexicalCandidates, semanticCandidates, 30),
          forcedBoostCandidates,
          30 + forcedBoostCandidates.length
        );

        if (!retrieved.length) {
          return buildAlternativeResult({
            shop,
            query: cleanQuery,
            candidates: [],
            goal: activeGoal,
            forcedBoostCandidates,
            semanticCandidates,
            lexicalCandidates
          });
        }

        const {
          candidatesForGlm,
          jevSelection
        } = resolveJevCandidatesForGlm({
          candidates: retrieved,
          forcedBoostCandidates
        });

        logJevShadowSelection({
          query: cleanQuery,
          candidates: retrieved,
          jevSelection
        });

        const aiStartedAt = Date.now();

        let aiResult;

        // Set when GLM could not answer; JEV answers instead.
        let glmFailure = null;

        try {
          aiResult = await recommendProducts({
            shop,
            query: cleanQuery,
            signal,
            products: buildAICatalog(
              selectTopCandidatesForAI({
                query: cleanQuery,
                candidates: candidatesForGlm,
                lexicalCandidates,
                semanticCandidates
              })
            )
          });

          /*
           * "invalid" = GLM returned nothing usable: ran out of
           * tokens, empty or unparseable output, or only SKUs that
           * aren't in the catalog. A real "no match" answer is
           * "none" and is kept as GLM's decision.
           */
          if (aiResult?.resultType === "invalid") {
            glmFailure = aiResult.failure || "invalid_ai_response";
          }
        } catch (error) {
          // Usage limit (429), timeout, network or server error.
          glmFailure = error.message;
        }

        /*
         * The customer kept typing and the storefront cancelled
         * this search: nobody will see the answer, so stop here.
         */
        if (signal?.aborted) {
          console.log(`[SEARCH SERVICE] AI request cancelled "${cleanQuery}" (customer kept typing)`);

          return {
            query: cleanQuery,
            intent: "cancelled",
            aborted: true,
            products: []
          };
        }

        if (glmFailure) {
          console.error(
            "[SEARCH SERVICE] AI unavailable, JEV is answering:",
            glmFailure
          );

          const ranked = rankPreviewCandidatesWithoutGlm({
            query: cleanQuery,
            candidates: candidatesForGlm,
            lexicalCandidates
          });

          aiResult = {
            intent: "product_search",
            resultType: ranked.resultType,
            recommendations: ranked.products.map(product => ({
              sku: productKey(product),
              score: product.recommendationScore,
              reason: product.recommendationReason
            }))
          };
        } else if (aiResult?.recommendations?.length) {
          /*
           * Evidence for JEV's quality: what JEV would have shown
           * (same ranking as its instant/fallback results: in
           * stock, one variant per product) vs what the AI picked.
           * In-memory only; logging must never affect the search.
           */
          try {
            const seenProducts = new Set();

            const jevRankedKeys = rankPreviewCandidatesWithoutGlm({
              query: cleanQuery,
              candidates: candidatesForGlm,
              lexicalCandidates
            }).products
              .filter(product => {
                const productId = product.shopifyProductId || productKey(product);

                if (product.availableForSale !== true || seenProducts.has(productId)) {
                  return false;
                }

                seenProducts.add(productId);
                return true;
              })
              .map(productKey);

            logJevVsGlmComparison({
              query: cleanQuery,
              jevRankedKeys,
              glmRecommendedMatchKeys: aiResult.recommendations.map(item => item?.sku),
              titles: new Map(candidatesForGlm.map(product => [productKey(product), product.title]))
            });
          } catch (error) {
            // comparison is diagnostic only
          }
        }

        console.log(`[SEARCH SERVICE] AI response time: ${Date.now() - aiStartedAt}ms`);

        aiResult = await resolveUnavailableDirectMatch({
          shop,
          query: cleanQuery,
          candidates: candidatesForGlm,
          lexicalCandidates,
          semanticCandidates,
          aiResult
        });

        aiResult = applySemanticFallbackIfNoRecommendations({
          query: cleanQuery,
          aiResult,
          semanticCandidates
        });

        const hydrated = await hydrateRecommendations({
          shop,
          recommendations: aiResult?.recommendations,
          minScore: 30
        });

        // Same as preview: never list a sold-out product.
        let verified = hydrated
          .filter(product => product.availableForSale)
          .sort((a, b) => b.recommendationScore - a.recommendationScore);

        let label = labelAvailableResult({
          query: cleanQuery,
          available: verified,
          soldOut: hydrated.filter(product => !product.availableForSale),
          resultType: aiResult?.resultType || "recommended",
          message: aiResult?.message
        });

        /*
         * GLM answered, but nothing it picked is in stock: offer
         * similar in-stock products instead of an empty page.
         */
        if (!verified.length) {
          const fallback = applySemanticFallbackIfNoRecommendations({
            query: cleanQuery,
            aiResult: { intent: "no_match", recommendations: [] },
            semanticCandidates: semanticCandidates.filter(product => product.availableForSale)
          });

          verified = await hydrateRecommendations({
            shop,
            recommendations: fallback.recommendations
          });

          if (verified.length) {
            aiResult = fallback;
            label = {
              resultType: fallback.resultType,
              message: fallback.message || ""
            };
          }
        }

        const products = applyMerchantRule({
          products: verified,
          goal: activeGoal,
          forcedBoostCandidates,
          semanticCandidates,
          lexicalCandidates,
          limit: Math.max(verified.length, 1) + forcedBoostCandidates.length
        });

        console.log(`[SEARCH TIMING] FINAL TOTAL: ${Date.now() - startedAt}ms`);

        const servedBy = glmFailure ? "JEV" : "GLM";

        if (!products.length) {
          return logModelResponse({
            servedBy,
            query: cleanQuery,
            reason: glmFailure,
            result: await buildAlternativeResult({
              shop,
              query: cleanQuery,
              candidates: [...semanticCandidates, ...candidatesForGlm],
              goal: activeGoal,
              forcedBoostCandidates,
              semanticCandidates,
              lexicalCandidates
            })
          });
        }

        return logModelResponse({
          servedBy,
          query: cleanQuery,
          reason: glmFailure,
          result: {
            query: cleanQuery,
            intent: aiResult?.intent || "product_search",
            resultType: label.resultType,
            message: label.message,
            products
          }
        });
      };


    module.exports = {
      searchProducts,
      findPrefixCandidates,
      findPartialCandidates,
      findExactSkuMatch,
      getForcedBoostCandidates,
      ensureBoostedProductsPresent,
      applyDemoteVisibilityCap,
      resolveJevCandidatesForGlm,
      rankPreviewCandidatesWithoutGlm,
      resolveUnavailableDirectMatch,
      applySemanticFallbackIfNoRecommendations
    };
