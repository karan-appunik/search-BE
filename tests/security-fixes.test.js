const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");

// =========================================================
// SECURITY AUDIT FIXES
// =========================================================
//
// Covers the 5 issues the security + multi-tenant isolation
// audit found and asked to be fixed:
//   1. POST /api/internal/products/sync had no auth at all.
//   2. GET  /api/ai-search/search had no auth at all — any
//      caller who knew the backend's URL could search another
//      shop's catalog directly, bypassing Shopify's app-proxy
//      signature check (that check only ever ran in the
//      app-proxy route, never in the backend doing the real
//      data access).
//   3. /api/internal/status always returned cross-shop "global"
//      data (every shop's domain + product count) to ANY
//      caller, including a regular merchant's own request.
//   4. cors() ran with no origin restriction at all.
//   5. Qdrant's searchByVector only attached its shop filter
//      `if (shop)` — a missing shop would silently search
//      across every tenant instead of failing.
//
// Route-wiring checks below inspect the actual Express Router's
// .stack (no live HTTP server needed) to confirm the middleware
// is really attached to the route, rather than just asserting
// the middleware function exists somewhere.
// =========================================================

// ---------------------------------------------------------
// 1 & (part of) 2 — internalAuth wired onto the actual routes
// ---------------------------------------------------------

test("POST /products/sync requires internalAuth", () => {
  const router = require("../src/routes/internal-product.routes");

  const syncLayer = router.stack.find(
    layer => layer.route?.path === "/products/sync"
  );

  assert.ok(syncLayer, "route /products/sync must exist");

  const middlewareNames = syncLayer.route.stack.map(layer => layer.name);

  assert.ok(
    middlewareNames.includes("internalAuth"),
    `expected internalAuth in the middleware chain, got: ${middlewareNames.join(", ")}`
  );
});

test("GET /api/ai-search/search requires internalAuth", () => {
  const router = require("../src/routes/ai-search.routes");

  const layerNames = router.stack.map(layer => layer.name);
  const authIndex = layerNames.indexOf("internalAuth");
  const searchRouteIndex = router.stack.findIndex(
    layer => layer.route?.path === "/search"
  );

  assert.ok(authIndex !== -1, "internalAuth must be registered on this router");
  assert.ok(searchRouteIndex !== -1, "route /search must exist");
  assert.ok(
    authIndex < searchRouteIndex,
    "internalAuth must run BEFORE the /search route handler"
  );
});

// ---------------------------------------------------------
// 1 & 2 (cont.) — the shared-secret middleware itself actually
// rejects a request with no/wrong secret and allows a correct one
// ---------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    }
  };
  return res;
}

test("internalAuth rejects a request with no secret header", () => {
  const { internalAuth } = require("../src/middleware/internal-auth");

  const req = { get: () => undefined, method: "POST", originalUrl: "/api/internal/products/sync" };
  const res = makeRes();
  let nextCalled = false;

  internalAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("internalAuth rejects a request with the wrong secret", () => {
  const { internalAuth } = require("../src/middleware/internal-auth");

  const req = {
    get: (name) => (name === "x-internal-api-secret" ? "totally-wrong-secret" : undefined),
    method: "GET",
    originalUrl: "/api/ai-search/search"
  };
  const res = makeRes();
  let nextCalled = false;

  internalAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("internalAuth allows a request with the correct secret", () => {
  const { internalAuth } = require("../src/middleware/internal-auth");

  const req = {
    get: (name) => (name === "x-internal-api-secret" ? process.env.INTERNAL_API_SECRET : undefined),
    method: "GET",
    originalUrl: "/api/ai-search/search"
  };
  const res = makeRes();
  let nextCalled = false;

  internalAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

// ---------------------------------------------------------
// 3 — status endpoints: no global data leaks to a shop-scoped call
//
// readShopStatus only touches MongoDB (product/goal repositories),
// so a DB connection is enough to test it, same as every other
// DB-backed suite. readGlobalStatus additionally calls Qdrant's
// and Ollama's reachability checks — both degrade gracefully
// (return "unreachable", never throw) rather than failing the
// request, so this test's assertion holds regardless of whether
// those services happen to be up right now; it may just take a
// few seconds longer if they're down.
// ---------------------------------------------------------

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
});

after(async () => {
  await mongoose.disconnect();
});

test("readShopStatus rejects a request with no shop (never falls back to global)", async () => {
  const { readShopStatus } = require("../src/controllers/status.controller");

  const req = { query: {} };
  const res = makeRes();

  await readShopStatus(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.data, undefined, "must not return any data, including global, without a shop");
});

test("readShopStatus's response never contains a global key", async () => {
  const { readShopStatus } = require("../src/controllers/status.controller");

  const req = { query: { shop: "leak-check-shop.myshopify.com" } };
  const res = makeRes();

  await readShopStatus(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(!("global" in res.body.data), "shop-scoped status must never include cross-shop global data");
  assert.ok("shop" in res.body.data);
});

test("readGlobalStatus's response never contains a shop-specific key at the top level", async () => {
  const { readGlobalStatus } = require("../src/controllers/status.controller");

  const req = { query: {} };
  const res = makeRes();

  await readGlobalStatus(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok("global" in res.body.data);
  assert.ok(!("shop" in res.body.data), "the global route must never return a single shop's detail");
});

test("/api/internal/status/global route exists and requires internalAuth", () => {
  const router = require("../src/routes/status.routes");

  const layerNames = router.stack.map(layer => layer.name);
  const authIndex = layerNames.indexOf("internalAuth");
  const globalRouteIndex = router.stack.findIndex(
    layer => layer.route?.path === "/global"
  );

  assert.ok(authIndex !== -1);
  assert.ok(globalRouteIndex !== -1, "route /global must exist");
  assert.ok(authIndex < globalRouteIndex, "internalAuth must run before /global");
});

// ---------------------------------------------------------
// 4 — restricted CORS allowlist
// ---------------------------------------------------------

test("CORS: allows requests with no Origin header (server-to-server, not a browser)", () => {
  const { isAllowedOrigin } = require("../src/config/cors-config");
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(""), true);
});

test("CORS: allows a *.myshopify.com origin", () => {
  const { isAllowedOrigin } = require("../src/config/cors-config");
  assert.equal(isAllowedOrigin("https://some-shop.myshopify.com"), true);
});

test("CORS: allows the embedded admin origin", () => {
  const { isAllowedOrigin } = require("../src/config/cors-config");
  assert.equal(isAllowedOrigin("https://admin.shopify.com"), true);
});

test("CORS: rejects an arbitrary untrusted origin", () => {
  const { isAllowedOrigin } = require("../src/config/cors-config");
  assert.equal(isAllowedOrigin("https://evil.com"), false);
});

test("CORS: rejects a lookalike domain that merely contains myshopify.com without the dot boundary", () => {
  const { isAllowedOrigin } = require("../src/config/cors-config");
  assert.equal(isAllowedOrigin("https://notmyshopify.com"), false);
  assert.equal(isAllowedOrigin("https://evilmyshopify.com.attacker.net"), false);
});

test("CORS: rejects a malformed origin instead of throwing", () => {
  const { isAllowedOrigin } = require("../src/config/cors-config");
  assert.equal(isAllowedOrigin("not-a-url"), false);
});

test("CORS middleware: a disallowed origin gets no CORS header and NEVER a 500/stack-trace leak", async () => {
  // Regression test for a real bug caught during live verification
  // of this fix: the first version called callback(new Error(...))
  // for a disallowed origin, which made the `cors` package throw
  // into Express's default error handler — rendering a full server
  // stack trace, with absolute file paths, back to the caller.
  // This spins up a real (ephemeral, random-port) Express app with
  // just the real cors middleware, so it exercises the actual
  // `cors` package's behavior, not just the pure isAllowedOrigin
  // predicate.
  const express = require("express");
  const cors = require("cors");
  const { corsOptions } = require("../src/config/cors-config");

  const app = express();
  app.use(cors(corsOptions));
  app.get("/probe", (req, res) => res.status(200).json({ ok: true }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  try {
    const port = server.address().port;

    const disallowed = await fetch(`http://localhost:${port}/probe`, {
      headers: { Origin: "https://evil.com" }
    });
    const disallowedBody = await disallowed.text();

    assert.equal(disallowed.status, 200, "must not error the request, just omit the CORS header");
    assert.equal(disallowed.headers.get("access-control-allow-origin"), null);
    assert.ok(!disallowedBody.includes("cors-config.js"), "must never leak a server-side stack trace");
    assert.ok(!disallowedBody.toLowerCase().includes("<pre>"), "must never render Express's HTML error page");

    const allowed = await fetch(`http://localhost:${port}/probe`, {
      headers: { Origin: "https://some-shop.myshopify.com" }
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://some-shop.myshopify.com");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------
// 5 — Qdrant fails loudly on a missing shop instead of
// silently searching across every tenant
// ---------------------------------------------------------

test("searchByVector throws when shop is missing", async () => {
  const { searchByVector } = require("../src/services/search/qdrant.service");

  await assert.rejects(
    () => searchByVector([0.1, 0.2, 0.3], { limit: 5 }),
    /shop is required/i
  );
});

test("searchByVector throws when shop is an empty string", async () => {
  const { searchByVector } = require("../src/services/search/qdrant.service");

  await assert.rejects(
    () => searchByVector([0.1, 0.2, 0.3], { shop: "", limit: 5 }),
    /shop is required/i
  );
});

test("searchByVector returns [] for an empty embedding without needing a shop (nothing to search)", async () => {
  const { searchByVector } = require("../src/services/search/qdrant.service");

  // No network call happens for an empty/invalid embedding — this
  // stays safe to run without live Qdrant, same precedent as
  // qdrant.delete-points.test.js.
  const result = await searchByVector([], { shop: "" });
  assert.deepEqual(result, []);
});
