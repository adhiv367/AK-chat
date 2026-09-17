const axios = require("axios");

async function getProduct(productId) {
  try {
    const store = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    const response = await axios.get(
      `https://${store}/admin/api/2025-04/products.json`,
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      }
    );

    const products = response.data.products || [];

    const product = products.find(
      (p) =>
        p.handle === productId ||
        String(p.id) === String(productId)
    );

    return product || null;
  } catch (err) {
    console.error("Shopify Fetch Error:", err.message);
    return null;
  }
}

module.exports = {
  getProduct,
};