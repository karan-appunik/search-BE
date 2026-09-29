const { searchProducts } = require("../services/search/search.service");

const search = async (req, res) => {
  try {
    const { shop, query } = req.body;

    const result = await searchProducts({
      shop,
      query
    });

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error("Search error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to search products"
    });
  }
};

module.exports = {
  search
};