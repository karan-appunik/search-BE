const Product = require("../../models/Product");

// =========================================================
// JEV RELEVANCE INDEX (in-process, no embedding model)
// =========================================================
//
// Scores every product of a shop against a search query in
// memory, with no model or network call. Replaces the old
// qwen3-embedding + vector search: JEV now produces its own
// relevance score instead of reading a vector similarity.
//
// Per meaningful query word, the best match in each product
// field counts:
//   - exact word (after singular/plural folding)     1.00
//   - partial word while typing ("jack" -> jacket)    0.85
//   - small typo ("golves" -> gloves)                0.75
// weighted by field (title counts most, description least) and
// by how rare the word is in this shop's catalog (a word on
// every product says little). The result is 0..1, on the same
// scale the rest of search already uses (_semanticScore), so
// JEV thresholds, Boost relevance and alternatives work
// unchanged.
//
// Understanding MEANING ("something warm for winter") is the
// AI model's job: when JEV finds no confident word match,
// search.service.js gives the AI a wider slice of the catalog.
//
// A shop's catalog is loaded once and cached; any product
// write calls invalidateShop(), and a short TTL covers writes
// made by other processes.
// =========================================================

const CACHE_TTL_MS = 60 * 1000;

const FIELD_WEIGHTS = {
  title: 3,
  productType: 2.5,
  tags: 2,
  variantTitle: 1.5,
  variantOptions: 1.5,
  vendor: 1.2,
  features: 1,
  benefits: 1,
  ingredients: 1,
  description: 0.8
};

const MAX_FIELD_WEIGHT = 3;

const MATCH_EXACT = 1;
const MATCH_PREFIX = 0.85;
const MATCH_TYPO = 0.75;

const LOAD_FIELDS =
  [
    "shop",
    "sku",
    "matchKey",
    "shopifyProductId",
    "shopifyVariantId",
    ...Object.keys(FIELD_WEIGHTS),
    "barcode",
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


// =========================================================
// TEXT
// =========================================================

/*
 * Singular/plural and simple suffix folding, so "jackets",
 * "jacket" and "dresses" / "dress" meet. Deliberately small:
 * over-stemming merges unrelated words.
 */
function stem(word) {
  let w = word;

  if (w.length > 4 && w.endsWith("ies")) {
    return w.slice(0, -3) + "y";
  }

  if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) {
    return w.slice(0, -2);
  }

  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) {
    w = w.slice(0, -1);
  }

  return w;
}

/*
 * Lowercase words of 2+ letters/digits. "t-shirt" also yields
 * "tshirt", so either spelling matches.
 */
function tokenize(text) {
  const clean = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");

  const tokens = [];

  for (const chunk of clean.split(/[^a-z0-9-]+/)) {
    if (!chunk) continue;

    const parts = chunk.split("-").filter(Boolean);

    for (const part of parts) {
      if (part.length >= 2) tokens.push(stem(part));
    }

    if (parts.length > 1) {
      tokens.push(stem(parts.join("")));
    }
  }

  return tokens;
}

/*
 * Damerau-Levenshtein (with adjacent swaps), stopping early once
 * the distance exceeds max.
 */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }

  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, (_, i) => {
    const row = new Array(cols).fill(0);
    row[0] = i;
    return row;
  });

  for (let j = 0; j < cols; j++) d[0][j] = j;

  for (let i = 1; i < rows; i++) {
    let rowMin = Infinity;

    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }

      rowMin = Math.min(rowMin, d[i][j]);
    }

    if (rowMin > max) {
      return max + 1;
    }
  }

  return d[a.length][b.length];
}

/*
 * How well one query word matches one catalog word (0 = not at
 * all). Typos only count for words of 4+ letters that start with
 * the same letter, so short words never fuzzy-match.
 */
function wordMatch(queryWord, catalogWord) {
  if (queryWord === catalogWord) {
    return MATCH_EXACT;
  }

  if (queryWord.length >= 3 && catalogWord.startsWith(queryWord)) {
    return MATCH_PREFIX;
  }

  if (
    queryWord.length >= 4 &&
    catalogWord.length >= 4 &&
    queryWord[0] === catalogWord[0]
  ) {
    const allowed = queryWord.length >= 8 ? 2 : 1;

    if (editDistance(queryWord, catalogWord, allowed) <= allowed) {
      return MATCH_TYPO;
    }
  }

  return 0;
}


// =========================================================
// INDEX (pure)
// =========================================================

function fieldText(value) {
  return Array.isArray(value) ? value.join(" ") : value;
}

function buildIndex(products) {
  const entries = [];
  const documentFrequency = new Map();

  for (const product of products || []) {
    const fields = {};
    const allWords = new Set();

    for (const field of Object.keys(FIELD_WEIGHTS)) {
      const words = new Set(tokenize(fieldText(product?.[field])));

      if (words.size) {
        fields[field] = words;
        words.forEach(word => allWords.add(word));
      }
    }

    allWords.forEach(word =>
      documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1)
    );

    entries.push({ product, fields });
  }

  return {
    entries,
    documentFrequency,
    vocabulary: [...documentFrequency.keys()],
    size: entries.length
  };
}

/*
 * Scores every product in the index for the given meaningful
 * query words (stop words already removed by the caller).
 * Returns products with a score above 0, best first (in-stock
 * before sold-out on ties), each with _semanticScore set.
 */
function scoreIndex(index, queryWords, limit = 30) {
  const words = [...new Set((queryWords || []).flatMap(tokenize))];

  if (!words.length || !index?.size) {
    return [];
  }

  // query word -> Map(catalog word -> match quality)
  const matches = words.map(word => {
    const found = new Map();

    for (const catalogWord of index.vocabulary) {
      const quality = wordMatch(word, catalogWord);
      if (quality) found.set(catalogWord, quality);
    }

    return found;
  });

  // rarer words weigh more; a word nobody has still counts, so
  // a query only half-found scores lower
  const weights = matches.map(found => {
    let best = 0;

    for (const catalogWord of found.keys()) {
      best = Math.max(best, index.documentFrequency.get(catalogWord) || 0);
    }

    return 1 + Math.log((index.size + 1) / (best + 1));
  });

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const scored = [];

  for (const entry of index.entries) {
    let sum = 0;
    let titleHits = 0;

    matches.forEach((found, i) => {
      if (!found.size) return;

      let best = 0;
      let inTitle = false;

      for (const [field, fieldWords] of Object.entries(entry.fields)) {
        for (const fieldWord of fieldWords) {
          const quality = found.get(fieldWord);
          if (!quality) continue;

          const value = quality * FIELD_WEIGHTS[field];

          if (value > best) best = value;
          if (field === "title") inTitle = true;
        }
      }

      if (best) {
        sum += weights[i] * (best / MAX_FIELD_WEIGHT);
        if (inTitle) titleHits++;
      }
    });

    if (!sum) continue;

    let score = sum / totalWeight;

    // every query word is in the title: a direct product match
    if (titleHits === words.length) {
      score = Math.min(1, score + 0.1);
    }

    scored.push({
      ...entry.product,
      _semanticScore: Math.round(score * 1000) / 1000
    });
  }

  return scored
    .sort((a, b) =>
      b._semanticScore - a._semanticScore ||
      Number(b.availableForSale === true) - Number(a.availableForSale === true)
    )
    .slice(0, limit);
}


// =========================================================
// PER-SHOP CACHE
// =========================================================

const cache = new Map();

function invalidateShop(shop) {
  if (shop) {
    cache.delete(shop);
  }
}

async function getShopIndex(shop) {
  if (!String(shop || "").trim()) {
    throw new Error("JEV index: shop is required");
  }

  const cached = cache.get(shop);

  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.promise;
  }

  const entry = {
    loadedAt: Date.now(),
    promise: Product.find({ shop })
      .select(LOAD_FIELDS)
      .lean()
      .then(buildIndex)
  };

  cache.set(shop, entry);

  // a failed load must not stay cached
  entry.promise.catch(() => {
    if (cache.get(shop) === entry) cache.delete(shop);
  });

  return entry.promise;
}

async function scoreShopProducts({
  shop,
  queryWords,
  limit = 30
}) {
  const index = await getShopIndex(shop);
  return scoreIndex(index, queryWords, limit);
}

/*
 * In-stock products of a shop, for the AI model when JEV found
 * no confident word match and meaning has to decide.
 */
async function getInStockProducts(shop, limit = 40) {
  const index = await getShopIndex(shop);

  return index.entries
    .map(entry => entry.product)
    .filter(product => product.availableForSale === true)
    .slice(0, limit);
}

function getJevIndexStatus() {
  return {
    engine: "JEV (in-process word relevance)",
    reachable: true,
    cachedShops: cache.size
  };
}

module.exports = {
  tokenize,
  stem,
  wordMatch,
  buildIndex,
  scoreIndex,
  scoreShopProducts,
  getInStockProducts,
  invalidateShop,
  getJevIndexStatus
};
