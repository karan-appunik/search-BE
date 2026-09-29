const crypto = require("crypto");


// =========================================================
// INTERNAL API AUTHENTICATION
// =========================================================
//
// The backend is reachable without any Shopify session, so
// internal endpoints that WRITE tenant data must be protected
// by a shared secret known only to the Shopify app.
//
// The secret is supplied through INTERNAL_API_SECRET and is
// never logged, echoed, or returned in a response.
// =========================================================

const HEADER_NAME =
  "x-internal-api-secret";


/*
 * Length-independent constant-time comparison.
 *
 * crypto.timingSafeEqual throws when the two buffers differ in
 * length, so the length check happens first. Length is not the
 * secret here, the value is.
 */
const secretsMatch = (
  provided,
  expected
) => {

  const providedBuffer =
    Buffer.from(
      String(provided),
      "utf8"
    );

  const expectedBuffer =
    Buffer.from(
      String(expected),
      "utf8"
    );


  if (
    providedBuffer.length !==
    expectedBuffer.length
  ) {

    return false;
  }


  return crypto.timingSafeEqual(
    providedBuffer,
    expectedBuffer
  );
};


const internalAuth = (
  req,
  res,
  next
) => {

  const expected =
    process.env.INTERNAL_API_SECRET ||
    "";


  /*
   * Server misconfiguration, not a client credential problem.
   *
   * Failing closed is deliberate: without a configured secret
   * these endpoints would be open to anyone who can reach the
   * port.
   */
  if (!expected) {

    console.error(
      "[INTERNAL AUTH] INTERNAL_API_SECRET is not configured; rejecting request"
    );


    return res.status(503).json({

      success: false,

      message:
        "Internal API is not configured"

    });
  }


  const provided =
    req.get(HEADER_NAME) ||
    "";


  if (
    !provided ||
    !secretsMatch(
      provided,
      expected
    )
  ) {

    console.warn(
      "[INTERNAL AUTH] Rejected request",
      {
        method:
          req.method,

        path:
          req.originalUrl,

        hasHeader:
          Boolean(provided)
      }
    );


    return res.status(401).json({

      success: false,

      message:
        "Invalid internal API credentials"

    });
  }


  return next();
};


module.exports = {
  HEADER_NAME,
  internalAuth
};
