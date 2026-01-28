const express = require("express");
const cors = require("cors");
const pool = require("./db");   // ← povezivanje sa db.js

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------
// Test ruta — samo da vidiš da server radi
// ---------------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("DE–SR API is running ✅");
});

// ---------------------------------------------------------------------
// Glavna ruta: vraća sve reči za DE→SR
// ---------------------------------------------------------------------
app.get("/api/entries", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, headword, plain_text, content_html, image_url FROM entries WHERE direction = 'DE_SR' ORDER BY headword"
    );

    // Konverzija podataka u format koji frontend već očekuje
    const entries = result.rows.map(row => ({
      id: String(row.id),
      headword: row.headword,
      plainText: row.plain_text,
      contentHtml: row.content_html,
      image: row.image_url || null
    }));

    res.json(entries);
  } catch (err) {
    console.error("Error querying database:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------------------------------------------------------------------
// Start servera
// ---------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`DE–SR API is running on http://localhost:${PORT}`);
});
