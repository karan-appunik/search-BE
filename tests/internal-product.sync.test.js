const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const { syncProducts } = require("../src/controllers/internal-product.controller");

// =========================================================
// SKU-optional redesign.
//
// A variant with no SKU used to be skipped entirely — this was
// the actual App Store compatibility bug: Shopify does not
// require a merchant to enter a SKU on every variant.
//
// Every variant now syncs as long as it has a Shopify Variant
// ID (the one thing Shopify always provides and that never
// changes). Each product's real matching identity — its
// matchKey — is its SKU when it has one, otherwise its Shopify
// Variant ID (see Product.js). The only thing that can still be
// skipped is a variant with no Shopify Variant ID at all, which
// should not happen in real Shopify data.
// =========================================================

const SHOP = "test-shop-sync-skip-reporting.myshopify.com";
const OTHER_SHOP = "test-shop-sync-skip-reporting-other.myshopify.com";

function fakeRes() {
  const res = {};
  res.status = code => { res._status = code; return res; };
  res.json = body => { res._body = body; return res; };
  return res;
}

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Product.deleteMany({ shop: { $in: [SHOP, OTHER_SHOP] } });
});

after(async () => {
  await Product.deleteMany({ shop: { $in: [SHOP, OTHER_SHOP] } });
  await mongoose.disconnect();
});

test("a variant with a SKU syncs normally, unaffected — matchKey equals the real sku", async () => {
  const req = {
    body: {
      shop: SHOP,
      currency: "USD",
      products: [{
        id: "gid://shopify/Product/1",
        title: "Good Product",
        handle: "good-product",
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", sku: "SYNC-001", title: "Default", price: "10.00", availableForSale: true, inventoryQuantity: 5 }] }
      }]
    }
  };
  const res = fakeRes();
  await syncProducts(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.data.synced, 1);
  assert.equal(res._body.data.skipped, 0);
  assert.deepEqual(res._body.data.skippedItems, []);

  const saved = await Product.findOne({ shop: SHOP, sku: "SYNC-001" });
  assert.ok(saved);
  assert.equal(saved.matchKey, "SYNC-001");
});

test("a product variant with no SKU syncs successfully — the actual fix", async () => {
  const req = {
    body: {
      shop: SHOP,
      currency: "USD",
      products: [{
        id: "gid://shopify/Product/2",
        title: "New Product Without SKU",
        handle: "new-product-without-sku",
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/2", sku: "", title: "Default", price: "20.00", availableForSale: true, inventoryQuantity: 3 }] }
      }]
    }
  };
  const res = fakeRes();
  await syncProducts(req, res);

  assert.equal(res._body.data.synced, 1);
  assert.equal(res._body.data.skipped, 0);
  assert.deepEqual(res._body.data.skippedItems, []);

  const saved = await Product.findOne({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/2" });
  assert.ok(saved, "the SKU-less product must actually be saved");
  assert.equal(saved.sku, "");
  assert.equal(saved.matchKey, "variant:gid://shopify/ProductVariant/2");
  assert.equal(saved.title, "New Product Without SKU");
});

test("a whitespace-only SKU is treated the same as no SKU — still syncs, matchKey falls back to the variant ID", async () => {
  const req = {
    body: {
      shop: SHOP,
      currency: "USD",
      products: [{
        id: "gid://shopify/Product/3",
        title: "Whitespace SKU Product",
        handle: "whitespace-sku-product",
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/3", sku: "   ", title: "Default", price: "5.00", availableForSale: true, inventoryQuantity: 1 }] }
      }]
    }
  };
  const res = fakeRes();
  await syncProducts(req, res);

  assert.equal(res._body.data.synced, 1);
  assert.equal(res._body.data.skipped, 0);

  const saved = await Product.findOne({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/3" });
  assert.ok(saved);
  assert.equal(saved.sku, "");
  assert.equal(saved.matchKey, "variant:gid://shopify/ProductVariant/3");
});

test("a null SKU (not just empty string) also syncs successfully", async () => {
  const req = {
    body: {
      shop: SHOP,
      currency: "USD",
      products: [{
        id: "gid://shopify/Product/5",
        title: "Null SKU Product",
        handle: "null-sku-product",
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/5", sku: null, title: "Default", price: "15.00", availableForSale: true, inventoryQuantity: 2 }] }
      }]
    }
  };
  const res = fakeRes();
  await syncProducts(req, res);

  assert.equal(res._body.data.synced, 1);
  assert.equal(res._body.data.skipped, 0);
});

test("a product with two variants — one with a SKU, one without — both sync as separate, distinguishable documents", async () => {
  const req = {
    body: {
      shop: SHOP,
      currency: "USD",
      products: [{
        id: "gid://shopify/Product/6",
        title: "Multi-Variant Product",
        handle: "multi-variant-product",
        variants: {
          nodes: [
            { id: "gid://shopify/ProductVariant/6a", sku: "SYNC-006A", title: "Small", price: "10.00", availableForSale: true, inventoryQuantity: 4 },
            { id: "gid://shopify/ProductVariant/6b", sku: "", title: "Large", price: "12.00", availableForSale: true, inventoryQuantity: 2 }
          ]
        }
      }]
    }
  };
  const res = fakeRes();
  await syncProducts(req, res);

  assert.equal(res._body.data.synced, 2);
  assert.equal(res._body.data.skipped, 0);

  const variantA = await Product.findOne({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/6a" });
  const variantB = await Product.findOne({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/6b" });
  assert.ok(variantA);
  assert.ok(variantB);
  assert.equal(variantA.matchKey, "SYNC-006A");
  assert.equal(variantB.matchKey, "variant:gid://shopify/ProductVariant/6b");
  // Both variants share the same underlying Shopify product ID —
  // this is the pre-existing rogue unique index on shopifyProductId
  // alone (found and removed during the matchKey migration) that
  // would previously have made the second variant fail to save.
  assert.equal(variantA.shopifyProductId, variantB.shopifyProductId);
});

test("two SKU-less products never collide/overwrite each other", async () => {
  const req = {
    body: {
      shop: SHOP,
      currency: "USD",
      products: [
        {
          id: "gid://shopify/Product/7",
          title: "First Skuless Product",
          handle: "first-skuless-product",
          variants: { nodes: [{ id: "gid://shopify/ProductVariant/7", sku: "", title: "Default", price: "8.00", availableForSale: true, inventoryQuantity: 1 }] }
        },
        {
          id: "gid://shopify/Product/8",
          title: "Second Skuless Product",
          handle: "second-skuless-product",
          variants: { nodes: [{ id: "gid://shopify/ProductVariant/8", sku: "", title: "Default", price: "9.00", availableForSale: true, inventoryQuantity: 1 }] }
        }
      ]
    }
  };
  const res = fakeRes();
  await syncProducts(req, res);

  assert.equal(res._body.data.synced, 2);
  assert.equal(res._body.data.skipped, 0);

  const first = await Product.findOne({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/7" });
  const second = await Product.findOne({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/8" });
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.matchKey, second.matchKey);
  assert.equal(first.title, "First Skuless Product");
  assert.equal(second.title, "Second Skuless Product");
});

test("mixed batch: SKU and SKU-less products both sync in the same run", async () => {
  const req = {
    body: {
      shop: SHOP,
      currency: "USD",
      products: [
        {
          id: "gid://shopify/Product/9",
          title: "Valid Product",
          handle: "valid-product",
          variants: { nodes: [{ id: "gid://shopify/ProductVariant/9", sku: "SYNC-009", title: "Default", price: "15.00", availableForSale: true, inventoryQuantity: 2 }] }
        },
        {
          id: "gid://shopify/Product/10",
          title: "No-SKU Product",
          handle: "no-sku-product",
          variants: { nodes: [{ id: "gid://shopify/ProductVariant/10", sku: "", title: "Default", price: "15.00", availableForSale: true, inventoryQuantity: 2 }] }
        }
      ]
    }
  };
  const res = fakeRes();
  await syncProducts(req, res);

  assert.equal(res._body.data.synced, 2);
  assert.equal(res._body.data.skipped, 0);
});

test("re-syncing the same SKU-less variant updates the same document, not a new one", async () => {
  const build = title => ({
    shop: SHOP,
    currency: "USD",
    products: [{
      id: "gid://shopify/Product/11",
      title,
      handle: "resync-skuless-product",
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", sku: "", title: "Default", price: "10.00", availableForSale: true, inventoryQuantity: 1 }] }
    }]
  });

  const res1 = fakeRes();
  await syncProducts({ body: build("Original Title") }, res1);

  const res2 = fakeRes();
  await syncProducts({ body: build("Updated Title") }, res2);

  const count = await Product.countDocuments({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/11" });
  assert.equal(count, 1, "re-syncing must update the existing document, not create a second one");

  const saved = await Product.findOne({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/11" });
  assert.equal(saved.title, "Updated Title");
});

test("a variant later given a real SKU keeps the same document identity (still found by variant ID)", async () => {
  const withoutSku = {
    shop: SHOP,
    currency: "USD",
    products: [{
      id: "gid://shopify/Product/12",
      title: "Gains A SKU Later",
      handle: "gains-a-sku-later",
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/12", sku: "", title: "Default", price: "10.00", availableForSale: true, inventoryQuantity: 1 }] }
    }]
  };
  await syncProducts({ body: withoutSku }, fakeRes());

  const before = await Product.findOne({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/12" });
  assert.equal(before.matchKey, "variant:gid://shopify/ProductVariant/12");

  const withSku = {
    shop: SHOP,
    currency: "USD",
    products: [{
      id: "gid://shopify/Product/12",
      title: "Gains A SKU Later",
      handle: "gains-a-sku-later",
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/12", sku: "SYNC-012", title: "Default", price: "10.00", availableForSale: true, inventoryQuantity: 1 }] }
    }]
  };
  await syncProducts({ body: withSku }, fakeRes());

  const count = await Product.countDocuments({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/12" });
  assert.equal(count, 1, "gaining a SKU must update the same document, not create a new one");

  const after = await Product.findOne({ shop: SHOP, shopifyVariantId: "gid://shopify/ProductVariant/12" });
  assert.equal(after.sku, "SYNC-012");
  assert.equal(after.matchKey, "SYNC-012");
});

test("two different shops with SKU-less products, including a coincidentally-shared real SKU elsewhere, stay fully isolated", async () => {
  const shopABody = {
    shop: SHOP,
    currency: "USD",
    products: [
      {
        id: "gid://shopify/Product/iso-a-1",
        title: "Shop A Skuless Product",
        handle: "shop-a-skuless-product",
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/iso-a-1", sku: "", title: "Default", price: "10.00", availableForSale: true, inventoryQuantity: 1 }] }
      },
      {
        id: "gid://shopify/Product/iso-a-2",
        title: "Shop A Shared SKU Product",
        handle: "shop-a-shared-sku-product",
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/iso-a-2", sku: "SHARED-SKU", title: "Default", price: "10.00", availableForSale: true, inventoryQuantity: 1 }] }
      }
    ]
  };

  const shopBBody = {
    shop: OTHER_SHOP,
    currency: "USD",
    products: [
      {
        id: "gid://shopify/Product/iso-b-1",
        title: "Shop B Skuless Product",
        handle: "shop-b-skuless-product",
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/iso-b-1", sku: "", title: "Default", price: "20.00", availableForSale: true, inventoryQuantity: 1 }] }
      },
      {
        id: "gid://shopify/Product/iso-b-2",
        title: "Shop B Shared SKU Product",
        handle: "shop-b-shared-sku-product",
        // Same literal SKU as Shop A's product above — different
        // shop, must remain a completely separate document.
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/iso-b-2", sku: "SHARED-SKU", title: "Default", price: "20.00", availableForSale: true, inventoryQuantity: 1 }] }
      }
    ]
  };

  await syncProducts({ body: shopABody }, fakeRes());
  await syncProducts({ body: shopBBody }, fakeRes());

  const shopAProducts = await Product.find({ shop: SHOP, handle: { $in: ["shop-a-skuless-product", "shop-a-shared-sku-product"] } }).lean();
  const shopBProducts = await Product.find({ shop: OTHER_SHOP, handle: { $in: ["shop-b-skuless-product", "shop-b-shared-sku-product"] } }).lean();

  assert.equal(shopAProducts.length, 2);
  assert.equal(shopBProducts.length, 2);

  const sharedInA = shopAProducts.find(p => p.sku === "SHARED-SKU");
  const sharedInB = shopBProducts.find(p => p.sku === "SHARED-SKU");
  assert.ok(sharedInA);
  assert.ok(sharedInB);
  assert.equal(sharedInA.title, "Shop A Shared SKU Product");
  assert.equal(sharedInB.title, "Shop B Shared SKU Product");
  assert.notEqual(sharedInA._id.toString(), sharedInB._id.toString());

  // Neither shop's product listing leaked into the other shop.
  assert.ok(!shopBProducts.some(p => p.title.startsWith("Shop A")));
  assert.ok(!shopAProducts.some(p => p.title.startsWith("Shop B")));
});
