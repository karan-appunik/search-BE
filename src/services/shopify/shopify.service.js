const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2026-07";

const getShopifyGraphQLUrl = () => {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;

  if (!domain) {
    throw new Error(
      "SHOPIFY_STORE_DOMAIN is missing"
    );
  }

  return `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
};

const shopifyGraphQL = async (
  query,
  variables = {}
) => {
  const token =
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!token) {
    throw new Error(
      "SHOPIFY_ADMIN_ACCESS_TOKEN is missing"
    );
  }

  const url = getShopifyGraphQLUrl();

  console.log("Shopify request:", {
    url,
    hasToken: Boolean(token)
  });

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },

    body: JSON.stringify({
      query,
      variables
    })
  });

  const result = await response.json();

  console.log("Shopify response status:", response.status);

  if (!response.ok) {
    console.error(
      "Shopify HTTP error response:",
      result
    );

    throw new Error(
      `Shopify API HTTP error: ${response.status} - ${
        result?.errors
          ? JSON.stringify(result.errors)
          : JSON.stringify(result)
      }`
    );
  }

  if (result.errors?.length) {
    console.error(
      "Shopify GraphQL errors:",
      result.errors
    );

    throw new Error(
      result.errors
        .map((error) => error.message)
        .join(", ")
    );
  }

  return result.data;
};

module.exports = {
  shopifyGraphQL
};