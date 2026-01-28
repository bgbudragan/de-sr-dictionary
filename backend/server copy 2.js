const express = require("express");
const cors = require("cors");
const pool = require("./db"); // povezivanje sa db.js

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Test ruta
app.get("/", (req, res) => {
  res.send("DE–SR API is running ✅");
});

// Glavna ruta: /api/entries?direction=DE_SR ili SR_DE
app.get("/api/entries", async (req, res) => {
  try {
    const dir = (req.query.direction || "DE_SR").toUpperCase();

    if (!["DE_SR", "SR_DE"].includes(dir)) {
      return res
        .status(400)
        .json({ error: "Invalid direction. Use DE_SR or SR_DE." });
    }

    const result = await pool.query(
      "SELECT id, headword, plain_text, content_html, image_url FROM entries WHERE direction = $1 ORDER BY headword",
      [dir]
    );

    const entries = result.rows.map((row) => ({
      id: String(row.id),
      headword: row.headword,
      plainText: row.plain_text,
      contentHtml: row.content_html,
      image: row.image_url || null,
    }));

    res.json(entries);
  } catch (err) {
    console.error("Error querying database:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Start servera
app.listen(PORT, () => {
  console.log(`API is running on port ${PORT}`);
});
