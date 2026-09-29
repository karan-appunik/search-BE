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
      require("./qdrant.service");


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

    // Qdrant cosine-similarity scores are used only for the second-stage
    // semantic fallback. Keep this configurable so the threshold can be
    // tuned from .env without changing the search code.
    const SEMANTIC_FALLBACK_MIN_SCORE = Number(
      process.env.SEMANTIC_FALLBACK_MIN_SCORE || "0.30"
    );

    console.log(
      "[SEARCH SERVICE] Semantic fallback minimum score:",
      SEMANTIC_FALLBACK_MIN_SCORE
    );

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

        "good"

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
      const terms = meaningful.slice(-3);

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
        "[SEARCH SERVICE] Partial lexical candidates:",
        candidates.map(product => ({
          sku: product?.sku,
          title: product?.title,
          productType: product?.productType
        }))
      );

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
      const terms = meaningful.slice(-3);

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
        "[SEARCH SERVICE] Partial lexical candidates:",
        candidates.map(product => ({
          sku: product?.sku,
          title: product?.title,
          productType: product?.productType
        }))
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
    // Qdrant finds semantically similar products.
    // MongoDB then loads the complete product records.
    //
    // If Qdrant is unavailable, return [] so the existing
    // lexical search can continue working.
    // =========================================================

    async function findSemanticCandidates({
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

            sku: {
              $in:
                uniqueSkus
            }
          })

            .select(
              [
                "shop",
                "sku",
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
                product.sku,
                product
              ]
            )
          );


        /*
         * Keep Qdrant similarity order.
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
          "[SEARCH SERVICE] Semantic candidates:",
          ordered.length
        );

        console.log(
          "[SEARCH SERVICE] Semantic top scores:",
          ordered.slice(0, 10).map(product => ({
            sku: product?.sku,
            title: product?.title,
            score: product?._semanticScore
          }))
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
          !product?.sku
        ) {
          continue;
        }


        merged.set(
          product.sku,
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
          !product?.sku
        ) {
          continue;
        }


        if (
          !merged.has(
            product.sku
          )
        ) {

          merged.set(
            product.sku,
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
              product.sku,

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
    // Never display raw semantic/Qdrant candidates as a fallback.
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
          String(product?.sku || "").trim(),
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
       * product-category or domain-specific vocabulary. Qwen/Qdrant remains
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
        sku: { $in: directSkus }
      })
        .select("sku availableForSale inventoryQuantity")
        .lean();

      const availabilityMap = new Map(
        directProducts.map(product => [
          String(product.sku),
          Boolean(product.availableForSale)
        ])
      );

      // Keep a direct result if at least one selected direct product
      // is currently available.
      const availableDirect = directSkus.some(
        sku => availabilityMap.get(sku) === true
      );

      if (availableDirect) {
        return aiResult;
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
        return aiResult;
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
       * Qwen + Qdrant are used here specifically to find semantically
       * similar alternatives. We do NOT ask the LLM to invent/rerank the
       * fallback list.
       */
      // Reuse the semantic candidates already retrieved for this request.
      // This avoids a second Qwen/Qdrant call and keeps preview fast.
      console.log(
        "[SEARCH SERVICE] Reusing semantic alternatives:",
        (semanticCandidates || []).length
      );

      const alternativeProducts = (semanticCandidates || [])
        .filter(product => {
          const sku = String(product?.sku || "").trim();
          return sku && !excluded.has(sku);
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
          sku: product.sku,
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
       * Qwen/Qdrant semantic retrieval to produce a bounded candidate
       * set. No product-category or domain-specific rules are used here.
       */
      const prefixPromise = findPrefixCandidates({
        shop,
        query: cleanQuery,
        limit: Math.min(10, limit)
      });

      const lexicalPromise = findCandidates({
        shop,
        query: cleanQuery
      });

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

      console.log(
        "[SEARCH SERVICE] Preview lexical evidence:",
        lexicalEvidence.slice(0, 12).map(product => ({
          sku: product?.sku,
          title: product?.title,
          productType: product?.productType
        }))
      );

      const merged = mergeCandidates(
        semanticCandidates || [],
        lexicalEvidence || [],
        Math.min(24, limit)
      );

      console.log(
        "[SEARCH SERVICE] Preview lexical candidates:",
        (prefixCandidates || []).concat(lexicalCandidates || []).slice(0, 12).map(product => ({
          sku: product?.sku,
          title: product?.title,
          productType: product?.productType
        }))
      );

      return {
        candidates: merged.slice(0, Math.min(24, limit)),
        lexicalCandidates: (lexicalEvidence || []).slice(0, 10),
        semanticCandidates: (semanticCandidates || []).slice(0, 18)
      };
    }

    // =========================================================
    // MAIN SEARCH
    // =========================================================

    const searchProducts =
      async ({
        shop,
        query,
        mode = "final"
      }) => {

        console.log(
          "[SEARCH SERVICE] searchProducts ENTERED",
          {
            shop,
            query
          }
        );


        if (
          !shop
        ) {

          throw new Error(
            "Shop is required"
          );

        }


        const cleanQuery =
          normalizeQuery(
            query
          );

        const searchMode =
          mode === "preview"
            ? "preview"
            : "final";

        console.log(
          "[SEARCH SERVICE] mode:",
          searchMode
        );


        if (
          !cleanQuery
        ) {

          return {

            query:
              "",

            intent:
              "empty",

            products:
              []

          };

        }


        // =======================================================
        // AI PREVIEW SEARCH
        // =======================================================
        //
        // Preview uses retrieval only to narrow the catalog to a
        // manageable candidate set. GLM then performs the actual
        // natural-language product selection and ranking.
        //
        // This keeps Qwen/Qdrant as infrastructure, not as the
        // final search decision-maker.
        // =======================================================

        if (searchMode === "preview") {
          const previewStartedAt = Date.now();

          console.log(
            "[SEARCH SERVICE] PREVIEW MODE - retrieval + GLM AI"
          );

          const previewRetrieval = await findPreviewCandidates({
            shop,
            query: cleanQuery,
            limit: 24
          });

          const candidates = previewRetrieval?.candidates || [];
          const lexicalCandidates = previewRetrieval?.lexicalCandidates || [];
          const semanticCandidates = previewRetrieval?.semanticCandidates || [];

          console.log(
            "[SEARCH SERVICE] Preview AI candidates:",
            candidates.length
          );

    console.log(
      "[SEARCH SERVICE] Preview candidate details:",
      candidates.map((p, index) => ({
        rank: index + 1,
        sku: p.sku,
        title: p.title,
        productType: p.productType
      }))
    );

          if (!candidates.length) {
            return {
              query: cleanQuery,
              intent: "no_match",
              products: []
            };
          }

          const aiProducts = buildAICatalog(candidates);

          const aiStartedAt = Date.now();

          const initialAIResult = await recommendProducts({
            query: cleanQuery,
            products: aiProducts,
            mode: "preview"
          });

          let aiResult = await resolveUnavailableDirectMatch({
            shop,
            query: cleanQuery,
            candidates,
            lexicalCandidates,
            semanticCandidates,
            aiResult: initialAIResult
          });

          /*
           * SECOND-STAGE SEMANTIC FALLBACK
           *
           * AI/GLM gets the first decision. If it cannot produce a valid
           * recommendation set, Qwen/Qdrant gets a second chance.
           *
           * This is intentionally different from the normal related-query
           * path: these products are alternatives, so the native Shopify UI
           * receives the exact fallback message.
           *
           * A similarity threshold prevents unrelated products from being
           * shown when the catalog simply has nothing useful for the query.
           */
          const aiRecommendations = Array.isArray(aiResult?.recommendations)
            ? aiResult.recommendations
            : [];

          if (
            !aiRecommendations.length &&
            semanticCandidates.length
          ) {
            console.log(
              "[SEARCH SERVICE] AI found no usable products; checking semantic fallback"
            );
            const semanticFallback = semanticCandidates
              .filter(product => {
                const score = Number(product?._semanticScore);
                return product?.sku &&
                  Number.isFinite(score) &&
                  Number.isFinite(SEMANTIC_FALLBACK_MIN_SCORE) &&
                  score >= SEMANTIC_FALLBACK_MIN_SCORE;
              })
              .slice(0, 6);

            console.log(
              "[SEARCH SERVICE] Semantic fallback candidates above threshold:",
              semanticFallback.map(product => ({
                sku: product?.sku,
                title: product?.title,
                score: product?._semanticScore
              }))
            );

            if (semanticFallback.length) {
              console.warn(
                "[SEARCH SERVICE] AI returned no usable result; using semantic alternatives"
              );

              aiResult = {
                intent: "product_search",
                resultType: "alternative",
                message: "We didn't find exactly that, but you might like these",
                recommendations: semanticFallback.map((product, index) => ({
                  sku: product.sku,
                  score: Math.max(50, 90 - index * 5),
                  reason: "Semantically similar alternative"
                }))
              };
            } else {
              console.log(
                "[SEARCH SERVICE] No semantic alternative passed similarity threshold"
              );
            }
          }

          console.log(
            `[SEARCH SERVICE] Preview AI response time: ${Date.now() - aiStartedAt}ms`
          );

          const recommendations = Array.isArray(
            aiResult?.recommendations
          )
            ? aiResult.recommendations
            : [];

          if (!recommendations.length) {
            return {
              query: cleanQuery,
              intent: aiResult?.intent || "no_match",
              resultType:
                aiResult?.resultType === "alternative"
                  ? "alternative"
                  : "none",
              message:
                aiResult?.message === "We didn't find exactly that, but you might like these"
                  ? aiResult.message
                  : "",
              products: []
            };
          }

          const recommendedSkus = recommendations
            .map(item => String(item?.sku || "").trim())
            .filter(Boolean);

          if (!recommendedSkus.length) {
            return {
              query: cleanQuery,
              intent: aiResult?.intent || "no_match",
              resultType: aiResult?.resultType || "none",
              message:
                aiResult?.message === "We didn't find exactly that, but you might like these"
                  ? aiResult.message
                  : "",
              products: []
            };
          }

          const fullProducts = await Product.find({
            shop,
            sku: { $in: recommendedSkus }
          }).lean();

          const productMap = new Map(
            fullProducts.map(product => [product.sku, product])
          );

          const verifiedProducts = recommendations
            .filter(
              recommendation =>
                recommendation &&
                recommendation.sku &&
                productMap.has(recommendation.sku)
            )
            .map(recommendation => {
              const product = productMap.get(recommendation.sku);

              let score = Number(
                recommendation.score ?? recommendation.relevanceScore
              );

              if (!Number.isFinite(score)) {
                score = 0;
              }

              score = Math.max(
                0,
                Math.min(98, Math.round(score))
              );

              return {
                ...product,
                recommendationScore: score,
                recommendationReason: String(
                  recommendation.reason || "Relevant product match"
                ).trim()
              };
            })
            .filter(Boolean)
            .slice(0, 6);

          console.log(
            "[SEARCH SERVICE] Preview verified AI products:",
            verifiedProducts.length
          );

          console.log(
            `[SEARCH TIMING] PREVIEW AI TOTAL: ${Date.now() - previewStartedAt}ms`
          );

          return {
            query: cleanQuery,
            intent: aiResult?.intent || "product_search",
            resultType:
              aiResult?.resultType === "alternative"
                ? "alternative"
                : "direct",
            message:
              aiResult?.message === "We didn't find exactly that, but you might like these"
                ? aiResult.message
                : "",
            products: verifiedProducts
          };
        }
    const searchStartedAt = Date.now();

    console.log(
      `[SEARCH TIMING] START query="${cleanQuery}"`
    );

    console.log(
      `[SEARCH TIMING] BACKEND TOTAL: ${
        Date.now() - searchStartedAt
      }ms`
    );

       // =======================================================
    // HYBRID CANDIDATES
    // =======================================================

    const candidateStartedAt =
      Date.now();


    /*
     * Run lexical and semantic retrieval
     * at the same time.
     *
     * This is important for speed.
     */
    const retrievalStartedAt = Date.now();

    const lexicalStartedAt = Date.now();

    const lexicalPromise = findCandidates({
      shop,
      query: cleanQuery
    }).then(result => {
      console.log(
        `[SEARCH TIMING] Mongo lexical: ${Date.now() - lexicalStartedAt}ms`
      );

      return result;
    });

    const semanticStartedAt = Date.now();

    const semanticPromise = findSemanticCandidates({
      shop,
      query: cleanQuery,
      limit: 30
    }).then(result => {
      console.log(
        `[SEARCH TIMING] Semantic retrieval (Qwen + Qdrant + Mongo): ${
          Date.now() - semanticStartedAt
        }ms`
      );

      return result;
    });

    const [
      lexicalCandidates,
      semanticCandidates
    ] = await Promise.all([
      lexicalPromise,
      semanticPromise
    ]);

    console.log(
      `[SEARCH TIMING] Retrieval total: ${
        Date.now() - retrievalStartedAt
      }ms`
    );


    const products =
      mergeCandidates(
        lexicalCandidates || [],
        semanticCandidates || [],
        30
      );


    console.log(
      `[SEARCH SERVICE] Hybrid retrieval: ${
        Date.now() -
        candidateStartedAt
      }ms`
    );


    console.log(
      "[SEARCH SERVICE] Lexical candidates:",
      lexicalCandidates?.length || 0
    );


    console.log(
      "[SEARCH SERVICE] Semantic candidates:",
      semanticCandidates.length
    );


    console.log(
      "[SEARCH SERVICE] Hybrid candidates:",
      products.length
    );

       if (
      !products.length
    ) {

      return {
        query:
          cleanQuery,

        intent:
          "no_products",

        products:
          []
      };
    }


        // =======================================================
        // AI
        // =======================================================

        console.log(
          "[SEARCH SERVICE] Calling recommendProducts"
        );


        const aiStartedAt =
          Date.now();


        const aiProducts =
      buildAICatalog(
        products
      );


    console.log(
      "[SEARCH SERVICE] AI products supplied:",
      aiProducts.length
    );


    const aiResult =
      await recommendProducts({
        query:
          cleanQuery,

        products:
          aiProducts
      });


        console.log(
          `[SEARCH SERVICE] AI response time: ${Date.now() -
          aiStartedAt
          }ms`
        );


        console.log(
          "[SEARCH SERVICE] AI result:",
          aiResult
        );


        // =======================================================
        // AI RECOMMENDATIONS
        // =======================================================

        const recommendations =
          Array.isArray(
            aiResult?.recommendations
          )
            ? aiResult.recommendations
            : [];


        if (
          !recommendations.length
        ) {

          return {

            query:
              cleanQuery,

            intent:
              aiResult?.intent ||
              "no_match",

            products:
              []

          };

        }


        const recommendedSkus =
          recommendations

            .map(
              recommendation =>
                String(
                  recommendation?.sku ||
                  ""
                ).trim()
            )

            .filter(Boolean);


        if (
          !recommendedSkus.length
        ) {

          return {

            query:
              cleanQuery,

            intent:
              "no_match",

            products:
              []

          };

        }


        // =======================================================
        // LOAD COMPLETE PRODUCT RECORDS
        // =======================================================

        const fullProducts =
          await Product.find({

            shop,

            sku: {
              $in:
                recommendedSkus
            }

          })
            .lean();


        const productMap =
          new Map(

            fullProducts.map(
              product => [

                product.sku,

                product

              ]
            )

          );


        // =======================================================
        // VERIFY AI RESULTS
        // =======================================================

        const verifiedProducts =
          recommendations

            .filter(
              recommendation =>

                recommendation &&

                recommendation.sku &&

                productMap.has(
                  recommendation.sku
                )

            )

            .map(
              recommendation => {

                const product =
                  productMap.get(
                    recommendation.sku
                  );


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

                  ...product,

                  recommendationScore:
                    score,

                  recommendationReason:
                    String(
                      recommendation.reason ||
                      "Relevant product match"
                    ).trim()

                };

              }

            )

            .filter(
              product =>
                product.recommendationScore >=
                30
            )

            .sort(
              (a, b) =>
                b.recommendationScore -
                a.recommendationScore
            );


        console.log(
          "[SEARCH SERVICE] Verified products:",
          verifiedProducts.length
        );


        if (
          !verifiedProducts.length
        ) {

          return {

            query:
              cleanQuery,

            intent:
              "no_match",

            products:
              []

          };

        }


        const finalResult = {

          query:
            cleanQuery,

          intent:
            aiResult?.intent ||
            "product_search",

          products:
            verifiedProducts

        };

        console.log(
          `[SEARCH TIMING] FINAL BACKEND TOTAL: ${
            Date.now() - searchStartedAt
          }ms`
        );

        return finalResult;

      };


    module.exports = {
      searchProducts
    };
