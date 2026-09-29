require("dotenv").config();

const express =
  require("express");

const cors =
  require("cors");

const connectDatabase =
  require("./config/database");

const searchRoutes =
  require("./routes/search.routes");

const internalProductRoutes =
  require("./routes/internal-product.routes");

const aiSearchRoutes =
  require("./routes/ai-search.routes");

const goalRoutes =
  require("./routes/goal.routes");

const {
  ensureGoalIndexes
} = require("./services/goal/goal.service");


const app =
  express();


const PORT =
  process.env.PORT || 5000;


// =========================================================
// CORS
// =========================================================

app.use(
  cors()
);


// =========================================================
// INTERNAL GOAL API
// =========================================================
//
// Mounted before the product-sync router so goal requests use
// their own small body limit and never pass through the 20mb
// product-sync parser.
//
// Authentication lives inside goal.routes.js.
// =========================================================

app.use(
  "/api/internal/goal",

  express.json({
    limit:
      "1mb"
  }),

  goalRoutes
);


// =========================================================
// INTERNAL PRODUCT SYNC
// =========================================================

app.use(
  "/api/internal",

  express.json({
    limit:
      "20mb"
  }),

  internalProductRoutes
);


// =========================================================
// NORMAL JSON
// =========================================================

app.use(
  express.json({
    limit:
      "1mb"
  })
);


// =========================================================
// HEALTH
// =========================================================

app.get(
  "/api/health",

  (req, res) => {

    return res.status(
      200
    ).json({

      success:
        true,

      message:
        "AI Product Search Backend is running"

    });

  }
);


// =========================================================
// ROUTES
// =========================================================

app.use(
  "/api/search",
  searchRoutes
);


app.use(
  "/api/internal",
  internalProductRoutes
);


app.use(
  "/api/ai-search",
  aiSearchRoutes
);


// =========================================================
// START
// =========================================================

const startServer =
  async () => {

    try {

      await connectDatabase();


      console.log(
        "MongoDB connected"
      );


      /*
       * The unique { shop } index is what enforces one goal
       * per shop, so make sure it exists before serving.
       */
      await ensureGoalIndexes();


      app.listen(
        PORT,

        () => {

          console.log(
            `Backend running on http://localhost:${PORT}`
          );

        }

      );

    } catch (error) {

      console.error(
        "Failed to start backend:",
        error
      );


      process.exit(
        1
      );

    }

  };


startServer();