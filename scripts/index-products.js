require("dotenv").config();


const mongoose =
  require("mongoose");

const Product =
  require("../src/models/Product");

const {
  buildEmbeddingText,
  getEmbeddingHash,
  createEmbeddings,
  OLLAMA_EMBEDDING_MODEL
} =
  require("../src/services/ai/embedding.service");

const {
  upsertProducts
} =
  require("../src/services/search/qdrant.service");


// =========================================================
// CONFIG
// =========================================================

const MONGODB_URI =
  process.env.MONGODB_URI;

const BATCH_SIZE =
  4;


// =========================================================
// MAIN
// =========================================================

async function main() {

  if (
    !MONGODB_URI
  ) {

    throw new Error(
      "MONGODB_URI is not configured"
    );
  }


  console.log(
    "[VECTOR INDEX] Connecting MongoDB..."
  );


  await mongoose.connect(
    MONGODB_URI
  );


  console.log(
    "[VECTOR INDEX] MongoDB connected"
  );

const mongoStartedAt =
  Date.now();

  const products =
    await Product.find({})
      .lean();

      console.log(
  `[MONGO] Semantic product lookup: ${
    Date.now() -
    mongoStartedAt
  }ms`
);


  console.log(
    "[VECTOR INDEX] Products:",
    products.length
  );


  if (
    !products.length
  ) {

    console.log(
      "[VECTOR INDEX] Nothing to index"
    );

    return;
  }


  let indexed =
    0;


  for (
    let offset = 0;
    offset < products.length;
    offset += BATCH_SIZE
  ) {

    const batch =
      products.slice(
        offset,
        offset +
          BATCH_SIZE
      );


    const texts =
      batch.map(
        buildEmbeddingText
      );


    console.log(
      `[VECTOR INDEX] Embedding ${offset + 1}-${Math.min(
        offset + BATCH_SIZE,
        products.length
      )} of ${products.length}`
    );


    console.log(
  `[VECTOR INDEX] Requesting embeddings for ${texts.length} products...`
);

const embeddingStarted =
  Date.now();

const embeddings =
  await createEmbeddings(
    texts
  );

console.log(
  `[VECTOR INDEX] Embeddings received: ${embeddings.length} in ${
    Date.now() -
    embeddingStarted
  }ms`
);


    await upsertProducts(
      batch,
      embeddings
    );


    /*
     * Save embedding metadata in MongoDB.
     */
    const operations =
      batch.map(
        (
          product,
          index
        ) => {

          const embeddingText =
            texts[index];

          const embeddingHash =
            getEmbeddingHash(
              embeddingText
            );


          return {
            updateOne: {

              filter: {
                _id:
                  product._id
              },

              update: {
                $set: {

                  embeddingText,

                  embeddingHash,

                  embeddingModel:
                    OLLAMA_EMBEDDING_MODEL,

                  embeddingIndexedAt:
                    new Date()
                }
              }
            }
          };
        }
      );


    await Product.bulkWrite(
      operations,
      {
        ordered:
          false
      }
    );


    indexed +=
      batch.length;


    console.log(
      `[VECTOR INDEX] Indexed: ${indexed}/${products.length}`
    );
  }


  console.log(
    "[VECTOR INDEX] COMPLETE"
  );
}


main()
  .catch(
    error => {

      console.error(
        "[VECTOR INDEX] ERROR:",
        error
      );

      process.exitCode =
        1;

    }
  )
  .finally(
    async () => {

      await mongoose.disconnect();

    }
  );