const crypto = require("crypto");


// =========================================================
// CONFIG
// =========================================================

const OLLAMA_LOCAL_URL =
  (
    process.env.OLLAMA_LOCAL_URL ||
    "http://localhost:11434"
  ).replace(
    /\/+$/,
    ""
  );

const OLLAMA_EMBEDDING_MODEL =
  process.env.OLLAMA_EMBEDDING_MODEL ||
  "qwen3-embedding:0.6b";


// =========================================================
// BUILD SEARCH TEXT
// =========================================================

function buildEmbeddingText(
  product
) {
  const parts = [];


  function add(
    label,
    value
  ) {

    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      return;
    }


    if (
      Array.isArray(value)
    ) {

      if (!value.length) {
        return;
      }


      parts.push(
        `${label}: ${value.join(", ")}`
      );


      return;
    }


    parts.push(
      `${label}: ${String(value).trim()}`
    );
  }


  add(
    "Product",
    product.title
  );

  add(
    "Variant",
    product.variantTitle
  );

  add(
    "Variant options",
    product.variantOptions
  );

  add(
    "Description",
    product.description
  );

  add(
    "Product type",
    product.productType
  );

  add(
    "Brand",
    product.vendor
  );

  add(
    "Tags",
    product.tags
  );

  add(
    "Ingredients",
    product.ingredients
  );

  add(
    "Benefits",
    product.benefits
  );

  add(
    "Features",
    product.features
  );

  add(
    "SKU",
    product.sku
  );

  add(
    "Price",
    product.price
  );

  add(
    "Currency",
    product.currency
  );

  add(
    "Available for sale",
    product.availableForSale
      ? "yes"
      : "no"
  );


  return parts.join(
    "\n"
  );
}


// =========================================================
// HASH
// =========================================================

function getEmbeddingHash(
  text
) {

  return crypto
    .createHash(
      "sha256"
    )
    .update(
      String(text || ""),
      "utf8"
    )
    .digest("hex");
}


// =========================================================
// CREATE EMBEDDINGS
// =========================================================

async function createEmbeddings(
  texts
) {
  if (
    !Array.isArray(texts) ||
    !texts.length
  ) {
    return [];
  }

  const startedAt =
    Date.now();

  const response =
    await fetch(
      `${OLLAMA_LOCAL_URL}/api/embed`,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          Accept:
            "application/json"
        },

        body: JSON.stringify({
  model: OLLAMA_EMBEDDING_MODEL,
  input: texts,
  keep_alive: "30m"
})
      }
    );

  if (
    !response.ok
  ) {
    const errorText =
      await response.text();

    console.log(
      `[EMBEDDING] Qwen embedding failed: ${
        Date.now() - startedAt
      }ms`
    );

    throw new Error(
      `Ollama embeddings failed: ${response.status} ${errorText}`
    );
  }

  const data =
    await response.json();

  const embeddings =
    Array.isArray(
      data?.embeddings
    )
      ? data.embeddings
      : [];

  const embeddingTime =
    Date.now() -
    startedAt;

  console.log(
    `[EMBEDDING] Qwen embedding: ${embeddingTime}ms`
  );

  if (
    embeddings.length !==
    texts.length
  ) {
    throw new Error(
      `Embedding count mismatch. Expected ${texts.length}, got ${embeddings.length}`
    );
  }

  return embeddings;
}


// =========================================================
// SINGLE EMBEDDING
// =========================================================

async function createEmbedding(
  text
) {

  const embeddings =
    await createEmbeddings([
      text
    ]);


  return embeddings[0] || [];
}


// =========================================================
// EXPORT
// =========================================================

module.exports = {
  OLLAMA_EMBEDDING_MODEL,
  buildEmbeddingText,
  getEmbeddingHash,
  createEmbedding,
  createEmbeddings
};