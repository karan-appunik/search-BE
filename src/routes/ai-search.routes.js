const express = require("express");

const {
    searchProducts
} = require(
    "../services/search/search.service"
);

const {
    internalAuth
} = require("../middleware/internal-auth");

const router =
    express.Router();


/*
 * Only the Shopify app calls this (its app-proxy and admin
 * preview routes add the secret server-side). Without this
 * check anyone could read any shop's catalog by passing
 * ?shop= and run up LLM costs.
 */
router.use(
    internalAuth
);


router.get(
    "/search",
    async (
        req,
        res
    ) => {

        try {

            const query =
                String(
                    req.query.q ||
                    ""
                ).trim();

            const shop =
                String(
                    req.query.shop ||
                    ""
                ).trim();

            const mode =
                String(
                    req.query.mode ||
                    "preview"
                ).trim().toLowerCase();


            if (!query) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Search query is required"
                });

            }


            if (!shop) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Shop is required"
                });

            }


            if (
                mode !== "preview" &&
                mode !== "final"
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid search mode"
                });

            }


            console.log(
                `[AI SEARCH] ${mode} "${query}" (${shop})`
            );


            /*
             * The storefront cancels searches the customer typed
             * past; pass that on so an abandoned AI call is
             * cancelled too.
             */
            const controller =
                new AbortController();

            res.on("close", () => {
                if (!res.writableEnded) {
                    controller.abort();
                }
            });


            const result =
                await searchProducts({
                    shop,
                    query,
                    mode,
                    signal: controller.signal
                });


            if (result?.aborted || res.writableEnded || controller.signal.aborted) {
                return;
            }


            return res.status(200).json({
                success: true,
                ...result
            });

        } catch (error) {

            console.error(
                "[AI SEARCH ERROR]",
                error
            );


            return res.status(500).json({
                success: false,
                message:
                    "AI product search failed"
            });

        }

    }
);


module.exports = router;