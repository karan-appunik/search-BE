require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../src/models/Product");

// =========================================================
// ONE-TIME MIGRATION: sku -> matchKey
// =========================================================
//
// Every product that exists today was synced under the OLD
// rule (SKU required), so every existing document already has
// a real, non-empty sku. Backfilling matchKey = sku is a pure,
// safe, idempotent addition — it never touches any other field
// and never changes a document that already has a matchKey.
//
// This also fixes the product collection's indexes to match the
// new schema:
//   - drops the old unique { shop, sku } index (sku can no
//     longer be unique now that it's optional)
//   - drops a pre-existing, undeclared unique index on
//     shopifyProductId alone, found during this migration's
//     safety check — it is not declared anywhere in the current
//     schema and would incorrectly block a second variant of the
//     same Shopify product from ever syncing
//   - creates the new unique { shop, shopifyVariantId } index
//     and the new (non-unique) sku / matchKey lookup indexes
// =========================================================

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("[MIGRATE matchKey] Connected");

  const beforeIndexes = await Product.collection.indexes();
  console.log(
    "[MIGRATE matchKey] Indexes before:",
    beforeIndexes.map(i => `${i.name}${i.unique ? " (unique)" : ""}`)
  );

  const totalWithoutMatchKey = await Product.collection.countDocuments({
    matchKey: { $exists: false }
  });
  console.log(`[MIGRATE matchKey] Documents needing backfill: ${totalWithoutMatchKey}`);

  const suspicious = await Product.collection.countDocuments({
    matchKey: { $exists: false },
    $or: [{ sku: { $exists: false } }, { sku: "" }, { sku: null }]
  });
  if (suspicious > 0) {
    throw new Error(
      `Refusing to proceed: found ${suspicious} existing document(s) with no matchKey AND no sku. ` +
      `Under the old rule every existing document should already have a sku. Investigate before rerunning.`
    );
  }

  if (totalWithoutMatchKey > 0) {
    const result = await Product.collection.updateMany(
      { matchKey: { $exists: false } },
      [{ $set: { matchKey: "$sku" } }]
    );
    console.log(`[MIGRATE matchKey] Backfilled matchKey on ${result.modifiedCount} document(s)`);
  } else {
    console.log("[MIGRATE matchKey] Nothing to backfill");
  }

  // Drop indexes that no longer match the schema, if present.
  const indexNames = beforeIndexes.map(i => i.name);

  if (indexNames.includes("shop_1_sku_1")) {
    await Product.collection.dropIndex("shop_1_sku_1");
    console.log("[MIGRATE matchKey] Dropped old unique index shop_1_sku_1");
  }

  if (indexNames.includes("shopifyProductId_1")) {
    await Product.collection.dropIndex("shopifyProductId_1");
    console.log("[MIGRATE matchKey] Dropped pre-existing undeclared unique index shopifyProductId_1");
  }

  // Create every index the schema now declares (idempotent —
  // does nothing if already present under the same name/spec).
  await Product.syncIndexes();
  console.log("[MIGRATE matchKey] Synced indexes to match the current schema");

  const afterIndexes = await Product.collection.indexes();
  console.log(
    "[MIGRATE matchKey] Indexes after:",
    afterIndexes.map(i => `${i.name}${i.unique ? " (unique)" : ""}`)
  );

  const stillMissing = await Product.collection.countDocuments({ matchKey: { $exists: false } });
  console.log(`[MIGRATE matchKey] Documents still missing matchKey: ${stillMissing}`);

  console.log("[MIGRATE matchKey] DONE");
}

main()
  .catch(error => {
    console.error("[MIGRATE matchKey] FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
