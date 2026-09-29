// =========================================================
// CORS CONFIGURATION
// =========================================================
//
// Security fix: this backend used to run `cors()` with no
// options at all, which allows any website's client-side
// JavaScript to read responses from every endpoint — including
// the two endpoints the same audit found were also missing
// authentication. No legitimate caller of this backend is ever a
// browser talking to it directly: the storefront widget calls
// Shopify's app proxy (same-origin on the merchant's own domain),
// and the embedded admin app's browser code only ever talks to
// its own app server, which then calls this backend
// server-to-server (CORS does not apply to server-to-server
// fetches at all — it's a browser-only mechanism). So a request
// with no Origin header (every legitimate caller) is always
// allowed; a browser request FROM an untrusted origin is not.
//
// Origins are restricted to Shopify's own domains — the embedded
// admin iframe (admin.shopify.com) and merchant storefronts
// (*.myshopify.com plus custom domains would need their own
// entry, but no current flow needs one) — rather than removing
// CORS entirely, so a future legitimate Shopify-hosted browser
// caller isn't blocked by default.
// =========================================================

const ALLOWED_ORIGIN_SUFFIXES = [
  ".myshopify.com",
  "admin.shopify.com"
];

function isAllowedOrigin(origin) {
  // No Origin header = not a cross-origin browser request (a
  // server-to-server call, curl, same-origin navigation, etc.) —
  // CORS only ever restricts browsers reading cross-origin
  // responses, so this is always safe to allow.
  if (!origin) {
    return true;
  }

  let hostname;

  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }

  return ALLOWED_ORIGIN_SUFFIXES.some(
    suffix =>
      hostname === suffix ||
      hostname.endsWith(suffix)
  );
}

const corsOptions = {
  origin(origin, callback) {
    /*
     * Passing `false` (not an Error) denies the CORS headers
     * without erroring the request. Erroring here would have the
     * `cors` package's callback throw into Express's error
     * handler, which — confirmed live — renders a full stack
     * trace (including absolute file paths) back to whoever sent
     * the disallowed Origin header. Denying silently is also the
     * technically correct behavior: the browser is what enforces
     * CORS by refusing to let page JS read a response with no
     * Access-Control-Allow-Origin header, not the server refusing
     * to respond at all.
     */
    callback(null, isAllowedOrigin(origin));
  }
};

module.exports = {
  isAllowedOrigin,
  corsOptions
};
