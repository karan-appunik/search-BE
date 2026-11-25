const mongoose = require("mongoose");


// =========================================================
// AI ANSWER CACHE (persistent)
// =========================================================
//
// The AI model's answer for a search, kept in MongoDB so it
// survives restarts/deploys (the in-memory cache in ai.service.js
// is lost on every restart). Same key as the in-memory cache
// (shop + search words + candidate products), stored only as a
// hash: no search text is kept.
//
// Expires on its own (TTL index on expiresAt), is cleared for a
// shop whenever its products change, and is deleted with the
// rest of the shop's data on shop/redact.
// =========================================================

const aiAnswerCacheSchema =
  new mongoose.Schema(
    {
      // sha256 of the in-memory cache key
      keyHash: {
        type: String,
        required: true,
        unique: true
      },

      shop: {
        type: String,
        required: true,
        index: true
      },

      // The AI's cleaned answer (resultType, recommendations, ...)
      value: {
        type: mongoose.Schema.Types.Mixed,
        required: true
      },

      expiresAt: {
        type: Date,
        required: true
      }
    },
    {
      minimize: false
    }
  );

// MongoDB removes expired answers by itself.
aiAnswerCacheSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);


module.exports =
  mongoose.models.AiAnswerCache ||
  mongoose.model("AiAnswerCache", aiAnswerCacheSchema);
