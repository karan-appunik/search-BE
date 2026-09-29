const express = require("express");

const {
    searchProducts
} = require(
    "../services/search/search.service"
);

const router =
    express.Router();


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
                "[AI SEARCH]",
                {
                    shop,
                    query,
                    mode
                }
            );


            const result =
                await searchProducts({
                    shop,
                    query,
                    mode
                });


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