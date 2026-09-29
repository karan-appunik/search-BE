const crypto =
  require("crypto");


// =========================================================
// CONFIG
// =========================================================

const QDRANT_URL =
  (
    process.env.QDRANT_URL ||
    "http://localhost:6333"
  ).replace(
    /\/+$/,
    ""
  );

const QDRANT_API_KEY =
  process.env.QDRANT_API_KEY ||
  "";

const COLLECTION_NAME =
  process.env.QDRANT_COLLECTION ||
  "shopify_product_search";


// =========================================================
// HEADERS
// =========================================================

function getHeaders() {

  const headers = {
    "Content-Type":
      "application/json",

    Accept:
      "application/json"
  };


  if (
    QDRANT_API_KEY
  ) {

    headers["api-key"] =
      QDRANT_API_KEY;
  }


  return headers;
}


// =========================================================
// DETERMINISTIC UUID
// =========================================================

function makePointId(
  shop,
  sku
) {

  const hash =
    crypto
      .createHash(
        "md5"
      )
      .update(
        `${shop}:${sku}`,
        "utf8"
      )
      .digest("hex");


  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32)
  ].join("-");
}


// =========================================================
// ENSURE COLLECTION
// =========================================================

async function ensureCollection(
  vectorSize
) {

  if (
    !Number.isInteger(
      vectorSize
    ) ||
    vectorSize <= 0
  ) {

    throw new Error(
      "A valid vector size is required"
    );
  }


  const check =
    await fetch(
      `${QDRANT_URL}/collections/${encodeURIComponent(
        COLLECTION_NAME
      )}`,
      {
        method:
          "GET",

        headers:
          getHeaders()
      }
    );


  if (
    check.ok
  ) {

    return true;
  }


  if (
    check.status !==
    404
  ) {

    const errorText =
      await check.text();


    throw new Error(
      `Qdrant collection check failed: ${check.status} ${errorText}`
    );
  }


  const response =
    await fetch(
      `${QDRANT_URL}/collections/${encodeURIComponent(
        COLLECTION_NAME
      )}`,
      {
        method:
          "PUT",

        headers:
          getHeaders(),

        body:
          JSON.stringify({
            vectors: {
              size:
                vectorSize,

              distance:
                "Cosine"
            }
          })
      }
    );


  if (
    !response.ok
  ) {

    const errorText =
      await response.text();


    throw new Error(
      `Qdrant collection creation failed: ${response.status} ${errorText}`
    );
  }


  return true;
}


// =========================================================
// UPSERT PRODUCTS
// =========================================================

async function upsertProducts(
  products,
  embeddings
) {

  if (
    !products.length
  ) {

    return;
  }


  if (
    products.length !==
    embeddings.length
  ) {

    throw new Error(
      "Product / embedding count mismatch"
    );
  }


  const vectorSize =
    embeddings[0]?.length;


  await ensureCollection(
    vectorSize
  );


  const points =
    products.map(
      (
        product,
        index
      ) => ({
        id:
          makePointId(
            product.shop,
            product.sku
          ),

        vector:
          embeddings[index],

        payload: {

          shop:
            product.shop,

          sku:
            product.sku,

          shopifyProductId:
            product.shopifyProductId ||
            "",

          shopifyVariantId:
            product.shopifyVariantId ||
            "",

          title:
            product.title ||
            "",

          embeddingModel:
            process.env.OLLAMA_EMBEDDING_MODEL ||
            "qwen3-embedding:0.6b"
        }
      })
    );


  const response =
    await fetch(
      `${QDRANT_URL}/collections/${encodeURIComponent(
        COLLECTION_NAME
      )}/points?wait=true`,
      {
        method:
          "PUT",

        headers:
          getHeaders(),

        body:
          JSON.stringify({
            points
          })
      }
    );


  if (
    !response.ok
  ) {

    const errorText =
      await response.text();


    throw new Error(
      `Qdrant upsert failed: ${response.status} ${errorText}`
    );
  }
}


// =========================================================
// VECTOR SEARCH
// =========================================================

async function searchByVector(
  embedding,
  {
    shop,
    limit = 30
  } = {}
) {

  if (
    !Array.isArray(
      embedding
    ) ||
    !embedding.length
  ) {

    return [];
  }


  const body = {
    query:
      embedding,

    limit:
      Math.min(
        Math.max(
          Number(limit) || 30,
          1
        ),
        100
      ),

    with_payload:
      true,

    with_vector:
      false
  };


  if (
    shop
  ) {

    body.filter = {
      must: [
        {
          key:
            "shop",

          match: {
            value:
              shop
          }
        }
      ]
    };
  }


  const response =
    await fetch(
      `${QDRANT_URL}/collections/${encodeURIComponent(
        COLLECTION_NAME
      )}/points/query`,
      {
        method:
          "POST",

        headers:
          getHeaders(),

        body:
          JSON.stringify(
            body
          )
      }
    );


  if (
    response.status ===
    404
  ) {

    return [];
  }


  if (
    !response.ok
  ) {

    const errorText =
      await response.text();


    throw new Error(
      `Qdrant vector search failed: ${response.status} ${errorText}`
    );
  }


  const data =
    await response.json();


  if (
    Array.isArray(
      data?.result?.points
    )
  ) {

    return data.result.points;
  }


  if (
    Array.isArray(
      data?.result
    )
  ) {

    return data.result;
  }


  return [];
}


// =========================================================
// EXPORT
// =========================================================

module.exports = {
  COLLECTION_NAME,
  ensureCollection,
  upsertProducts,
  searchByVector,
  makePointId
};