const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  tokenize,
  wordMatch,
  buildIndex,
  scoreIndex
} = require("../src/services/search/jev-index.service");

// =========================================================
// Pure — no DB, no network. JEV's in-process relevance scoring,
// which replaced the qwen3 embedding model.
// =========================================================

const catalog = [
  { matchKey: "JKT", title: "Classic Denim Jacket", productType: "Jacket", tags: ["denim"], availableForSale: true },
  { matchKey: "TEE", title: "Classic Cotton T-Shirt", productType: "T-Shirt", tags: ["cotton"], availableForSale: true },
  { matchKey: "GLV", title: "Leather Gloves", productType: "Accessories", tags: ["winter"], availableForSale: true },
  { matchKey: "HOOD", title: "Oversized Hoodie", productType: "Hoodie", tags: ["winter", "warm"], availableForSale: true },
  { matchKey: "MUG", title: "Ceramic Coffee Mug", productType: "Kitchen", description: "Keeps coffee warm", availableForSale: true },
  { matchKey: "JKT-SOLD", title: "Wool Jacket", productType: "Jacket", availableForSale: false }
];

const index = buildIndex(catalog);
const keys = query => scoreIndex(index, query.split(" ")).map(p => p.matchKey);
const scoreOf = (query, key) => scoreIndex(index, query.split(" ")).find(p => p.matchKey === key)?._semanticScore;

test("tokenize folds plurals and joins hyphenated words", () => {
  assert.deepEqual(tokenize("Jackets"), ["jacket"]);
  assert.deepEqual(tokenize("T-Shirt"), ["shirt", "tshirt"]);
  assert.deepEqual(tokenize("Dresses"), ["dress"]);
});

test("wordMatch: exact > partial word > typo > no match", () => {
  assert.equal(wordMatch("jacket", "jacket"), 1);
  assert.ok(wordMatch("jack", "jacket") > wordMatch("golve", "glove"));
  assert.ok(wordMatch("golve", "glove") > 0, "an adjacent-letter swap is a typo match");
  assert.equal(wordMatch("cap", "mug"), 0);
  assert.equal(wordMatch("ab", "abc"), 0, "2-letter words never partially match");
});

test("an exact title match scores 1 and ranks first", () => {
  assert.equal(keys("jacket")[0], "JKT");
  assert.equal(scoreOf("jacket", "JKT"), 1);
});

test("partial word while typing finds the product", () => {
  assert.ok(keys("jack").includes("JKT"));
});

test("a typo still finds the product", () => {
  assert.equal(keys("golves")[0], "GLV");
});

test("t-shirt and tshirt both match the T-Shirt", () => {
  assert.equal(keys("t-shirt")[0], "TEE");
  assert.equal(keys("tshirt")[0], "TEE");
});

test("a word in the title outranks the same word only in the description", () => {
  assert.ok(scoreOf("warm", "HOOD") > scoreOf("warm", "MUG"));
});

test("matching only part of the query scores lower than matching all of it", () => {
  assert.ok(scoreOf("denim jacket", "JKT") > scoreOf("denim jacket", "JKT-SOLD"));
});

test("in stock ranks before sold out on an equal score", () => {
  const index2 = buildIndex([
    { matchKey: "SOLD", title: "Red Scarf", availableForSale: false },
    { matchKey: "AVAIL", title: "Red Scarf", availableForSale: true }
  ]);
  assert.equal(scoreIndex(index2, ["scarf"])[0].matchKey, "AVAIL");
});

test("words the catalog doesn't have return nothing (left to the AI model)", () => {
  assert.deepEqual(keys("spaceship"), []);
});

test("scores stay within 0..1", () => {
  for (const product of scoreIndex(index, ["classic", "denim", "jacket"])) {
    assert.ok(product._semanticScore > 0 && product._semanticScore <= 1);
  }
});
