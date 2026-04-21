const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const FEED_URL = "https://files.channable.com/zPY8Lz2ruUG2WKjsrrUEvA==.xml";

app.use(cors());
app.use(express.json());

function decodeXml(value = "") {
  return value
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function getTagValue(itemXml, tagName) {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = itemXml.match(regex);
  return match ? decodeXml(match[1]) : "";
}

function parseFeedItems(xml) {
  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

  return itemMatches.map((itemXml) => ({
    gtin: getTagValue(itemXml, "gtin"),
    title: getTagValue(itemXml, "title"),
    brand: getTagValue(itemXml, "brand"),
    size: getTagValue(itemXml, "size"),
    id: getTagValue(itemXml, "id")
  }));
}

async function findProductsByBarcodes(barcodes) {
  const response = await fetch(FEED_URL);

  if (!response.ok) {
    throw new Error(`Feed kunne ikke hentes. Status: ${response.status}`);
  }

  const xml = await response.text();
  const allItems = parseFeedItems(xml);

  return barcodes.map((barcode) => {
    const product = allItems.find((item) => item.gtin === barcode);

    if (!product) {
      return {
        barcode,
        found: false,
        title: "IKKE FUNDET I FEED",
        brand: "",
        size: "",
        id: ""
      };
    }

    return {
      barcode,
      found: true,
      title: product.title,
      brand: product.brand,
      size: product.size,
      id: product.id
    };
  });
}


app.post("/lookup-product", async (req, res) => {
  try {
    const barcode = req.body?.barcode;

    if (!barcode) {
      return res.status(400).json({
        success: false,
        message: "Mangler barcode"
      });
    }

    const products = await findProductsByBarcodes([barcode]);
    const product = products[0];

    res.json({
      success: true,
      item: {
        barcode,
        found: product?.found || false,
        title: product?.title || "IKKE FUNDET I FEED",
        brand: product?.brand || "",
        size: product?.size || "",
        id: product?.id || ""
      }
    });
  } catch (error) {
    console.error("Fejl i /lookup-product:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/send-locations", async (req, res) => {
  try {
    const scans = Array.isArray(req.body) ? req.body : [];

    console.log("Modtaget fra app:", scans);

    const barcodes = scans.map((scan) => scan.barcode);
    const products = await findProductsByBarcodes(barcodes);

    const result = scans.map((scan) => {
      const product = products.find((item) => item.barcode === scan.barcode);

      return {
        barcode: scan.barcode,
        location: scan.location,
        found: product?.found || false,
        title: product?.title || "IKKE FUNDET I FEED",
        brand: product?.brand || "",
        size: product?.size || "",
        id: product?.id || ""
      };
    });

    console.log("Resultat med varedata:", result);

    res.json({
      success: true,
      message: "Data modtaget og varer slået op",
      receivedCount: scans.length,
      items: result
    });
  } catch (error) {
    console.error("Fejl i /send-locations:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server kører på http://localhost:${PORT}`);
});