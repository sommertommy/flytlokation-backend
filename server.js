const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;
const FEED_URL = "https://files.channable.com/zPY8Lz2ruUG2WKjsrrUEvA==.xml";
const FEED_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

let productIndex = {};
let productCount = 0;
let lastFeedUpdate = null;
let feedLoadingPromise = null;

function createMailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || "false") === "true";

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass
    }
  });
}

function buildLocationEmailText(items) {
  const lines = [
    "Ny varelokation registreret",
    ""
  ];

  items.forEach((item, index) => {
    lines.push(`Vare ${index + 1}`);
    lines.push(`Navn: ${item.title || "IKKE FUNDET I FEED"}`);
    lines.push(`Stregkode: ${item.barcode}`);
    lines.push(`Lokation: ${item.location}`);

    if (item.brand) {
      lines.push(`Brand: ${item.brand}`);
    }

    if (item.size) {
      lines.push(`Størrelse: ${item.size}`);
    }

    if (item.id) {
      lines.push(`Variant ID: ${item.id}`);
    }

    lines.push("");
  });

  return lines.join("\n");
}

async function sendLocationEmail(items) {
  const transporter = createMailTransporter();
  const from = process.env.MAIL_FROM;
  const to = process.env.MAIL_TO;

  if (!transporter || !from || !to) {
    throw new Error("Mail er ikke konfigureret. Mangler SMTP eller MAIL_FROM/MAIL_TO miljøvariabler.");
  }

  const subject = `Ny varelokation registreret (${items.length} varer)`;
  const text = buildLocationEmailText(items);

  console.log("Forsøger at sende email...", {
    from,
    to,
    subject,
    itemCount: items.length
  });

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    text
  });

  console.log("Email sendt", {
    messageId: info.messageId,
    response: info.response
  });
}

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

async function refreshFeedIndex() {
  const response = await fetch(FEED_URL);

  if (!response.ok) {
    throw new Error(`Feed kunne ikke hentes. Status: ${response.status}`);
  }

  const xml = await response.text();
  const allItems = parseFeedItems(xml);
  const nextIndex = {};

  allItems.forEach((item) => {
    if (item.gtin) {
      nextIndex[item.gtin] = item;
    }
  });

  productIndex = nextIndex;
  productCount = Object.keys(nextIndex).length;
  lastFeedUpdate = new Date().toISOString();

  console.log(`Feed indeks opdateret. ${productCount} varer indlæst.`);
}

async function ensureFeedIndexLoaded() {
  if (productCount > 0) {
    return;
  }

  if (!feedLoadingPromise) {
    feedLoadingPromise = refreshFeedIndex()
      .catch((error) => {
        throw error;
      })
      .finally(() => {
        feedLoadingPromise = null;
      });
  }

  await feedLoadingPromise;
}

function findProductByBarcode(barcode) {
  const product = productIndex[barcode];

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
}

async function findProductsByBarcodes(barcodes) {
  await ensureFeedIndexLoaded();
  return barcodes.map((barcode) => findProductByBarcode(barcode));
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

    await ensureFeedIndexLoaded();
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

    await ensureFeedIndexLoaded();
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

    await sendLocationEmail(result);
    console.log("Email-funktionen er kørt færdig uden fejl.");

    res.json({
      success: true,
      message: "Data modtaget, varer slået op og email sendt",
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

refreshFeedIndex()
  .catch((error) => {
    console.error("Fejl ved første feed-opdatering:", error);
  });

setInterval(() => {
  refreshFeedIndex().catch((error) => {
    console.error("Fejl ved planlagt feed-opdatering:", error);
  });
}, FEED_REFRESH_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`Server kører på http://localhost:${PORT}`);
  console.log(`Seneste feed-opdatering: ${lastFeedUpdate || "ikke indlæst endnu"}`);
});