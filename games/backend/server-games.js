// Standalone games server. No changes to your existing backend.
// Comments in English.

import express from "express";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const app = express();
app.use(express.json());

// Serve static files from games/frontend
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gamesFrontendDir = path.resolve(__dirname, "../frontend");
app.use(express.static(gamesFrontendDir));

// DB: reuse same DATABASE_URL as your main backend
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function clampInt(n, min, max, fallback) {
  const x = Number.parseInt(n, 10);
  if (Number.isNaN(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

app.get("/api/game/gender-drill", async (req, res) => {
  const limit = clampInt(req.query.limit, 3, 30, 10);

  // Balanced split
  const derN = Math.round(limit * 0.4);
  const dieN = Math.floor((limit - derN) / 2);
  const dasN = limit - derN - dieN;

  const sql = `
    WITH pool AS (
      SELECT id, headword, gender
      FROM public.entries
      WHERE direction = 'DE_SR'
        AND pos = 'noun'
        AND gender IN ('der','die','das')
    ),
    pick AS (
      (SELECT * FROM pool WHERE gender='der' ORDER BY random() LIMIT $1)
      UNION ALL
      (SELECT * FROM pool WHERE gender='die' ORDER BY random() LIMIT $2)
      UNION ALL
      (SELECT * FROM pool WHERE gender='das' ORDER BY random() LIMIT $3)
    )
    SELECT * FROM pick
    ORDER BY random();
  `;

  try {
    const { rows } = await pool.query(sql, [derN, dieN, dasN]);
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");

    res.json({
      mode: "gender_drill",
      title: "der, das oder die? Ergänzen Sie.",
      items: rows.slice(0, limit).map((r, i) => ({
        letter: letters[i],
        id: r.id,
        headword: r.headword,
        answer: r.gender, // dev mode; later we can hide it
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.GAMES_PORT || 3100;
app.listen(port, () => {
  console.log(`Games server running: http://localhost:${port}`);
  console.log(`Open: http://localhost:${port}/gender-drill.html`);
});
