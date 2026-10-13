require("dotenv").config();
const mongoose = require("mongoose");

// =========================================================
// ONE-TIME CLEANUP: remove qwen3 embedding data
// =========================================================
//
// Search no longer uses an embedding model (JEV scores products
// itself, see src/services/search/jev-index.service.js). This
// removes the old vector data from every product document and
// drops its index. Idempotent: safe to run more than once.
//
//   npm run cleanup:embeddings
// =========================================================

const EMBEDDING_FIELDS = {
  embedding: "",
  hasEmbedding: "",
  embeddingText: "",
  embeddingHash: "",
  embeddingModel: "",
  embeddingIndexedAt: ""
};

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const products = mongoose.connection.db.collection("products");

  const result = await products.updateMany(
    {
      $or: Object.keys(EMBEDDING_FIELDS).map(field => ({ [field]: { $exists: true } }))
    },
    { $unset: EMBEDDING_FIELDS }
  );

  console.log(`[CLEANUP] Removed embedding data from ${result.modifiedCount} product(s)`);

  const indexes = await products.indexes();

  for (const index of indexes) {
    if (Object.keys(index.key).some(field => field in EMBEDDING_FIELDS)) {
      await products.dropIndex(index.name);
      console.log(`[CLEANUP] Dropped index ${index.name}`);
    }
  }

  console.log("[CLEANUP] DONE");
}

main()
  .catch(error => {
    console.error("[CLEANUP] FAILED:", error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
