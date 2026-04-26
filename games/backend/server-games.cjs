// games/backend/server-games.cjs
// Standalone games server that reuses the existing backend DB module.
// No changes to backend/server.js or frontend/index.html.

const path = require("path");
const express = require("express");

const app = express();
const IMAGES_DIR =
  process.env.IMAGES_DIR || path.resolve(__dirname, "../frontend/images");

app.use("/images", express.static(IMAGES_DIR));
app.use(express.json());

app.use(express.static(path.resolve(__dirname, "../frontend")));

// Serve images from Render persistent disk
app.use("/images", express.static("/var/data/images"));

// Try to load existing DB module from your backend
const dbMod = require(path.resolve(__dirname, "../../backend/db.js"));

// Build a unified query function regardless of how db.js exports things.
const query = async (sql, params = []) => {
  if (typeof dbMod?.query === "function") {
    return dbMod.query(sql, params);
  }
  if (dbMod?.pool?.query && typeof dbMod.pool.query === "function") {
    return dbMod.pool.query(sql, params);
  }
  if (dbMod?.client?.query && typeof dbMod.client.query === "function") {
    return dbMod.client.query(sql, params);
  }
  // Sometimes db.js exports Pool directly
  if (dbMod?.query && typeof dbMod.query === "function") {
    return dbMod.query(sql, params);
  }

  // If we got here, we don't know the export shape.
  const keys = dbMod ? Object.keys(dbMod) : [];
  throw new Error(
    `Unsupported backend/db.js export shape. Keys: ${keys.join(", ")}`
  );
};

function clampInt(n, min, max, fallback) {
  const x = Number.parseInt(n, 10);
  if (Number.isNaN(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

// ---------------------------------------------------------------------
// Dictionary API (v0): suggestions + minimal detail
// ---------------------------------------------------------------------
app.get("/api/dict/search", async (req, res) => {
  const dir = String(req.query.direction || "DE_SR").toUpperCase();
  const q = String(req.query.q || "").trim();
  const limit = clampInt(req.query.limit, 1, 50, 20);

  // Pagination
  const offset = clampInt(req.query.offset, 0, 1000000, 0);

  if (!["DE_SR", "SR_DE"].includes(dir)) {
    return res
      .status(400)
      .json({ error: "Invalid direction. Use DE_SR or SR_DE." });
  }

  try {
    // Empty query: return first N alphabetically (+ offset)
    if (!q) {
      const r = await query(
        `SELECT id, headword, main_gloss, raw_clean, pos, gender, level, topics, plural, plural_full, image_url
         FROM public.entries
         WHERE direction = $1
         ORDER BY headword
         LIMIT $2 OFFSET $3`,
        [dir, limit, offset]
      );
      return res.json(r.rows || r);
    }

    // Prefix match (fast autocomplete) (+ offset)
    const r = await query(
      `SELECT id, headword, main_gloss, raw_clean, pos, gender, level, topics, plural, plural_full, image_url
       FROM public.entries
       WHERE direction = $1
         AND headword ILIKE $2
       ORDER BY headword
       LIMIT $3 OFFSET $4`,
      [dir, q + "%", limit, offset]
    );

    const rows = r.rows || r;

    // If prefix match found results, return them
    if (rows && rows.length > 0) {
      return res.json(rows);
    }

    // Fuzzy fallback (% operator uses GIN trigram index) — only when prefix returns nothing
    const fuzzy = await query(
      `SELECT id, headword, main_gloss, raw_clean, pos, gender, level, topics, plural, plural_full, image_url,
              similarity(lower(headword), lower($2)) AS sim
       FROM public.entries
       WHERE direction = $1
         AND lower(headword) % lower($2)
       ORDER BY sim DESC, headword
       LIMIT $3`,
      [dir, q, limit]
    );

    res.json(fuzzy.rows || fuzzy);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Optional: one entry by id (not strictly needed for v0)
app.get("/api/dict/entry/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const r = await query(
      `SELECT id, direction, headword, main_gloss, raw_clean, pos, gender, level, topics, plural, plural_full, image_url
       FROM public.entries
       WHERE id = $1`,
      [id]
    );

    const rows = r.rows || r;
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------
// Dictionary API: lookup single word (for tooltip/click on words in examples)
// ---------------------------------------------------------------------
app.get("/api/dict/lookup", async (req, res) => {
  const word = String(req.query.word || "").trim();
  const dir = String(req.query.direction || "").toUpperCase();

  if (!word) {
    return res.status(400).json({ error: "Missing 'word' parameter." });
  }
  if (!["DE_SR", "SR_DE"].includes(dir)) {
    return res
      .status(400)
      .json({ error: "Invalid direction. Use DE_SR or SR_DE." });
  }

  try {
    const r = await query(
      `SELECT id, headword, main_gloss
       FROM public.entries
       WHERE direction = $1
         AND lower(headword) = lower($2)
       LIMIT 1`,
      [dir, word]
    );

    const rows = r.rows || r;
    if (rows && rows.length > 0) {
      return res.json({
        found: true,
        id: rows[0].id,
        headword: rows[0].headword,
        main_gloss: rows[0].main_gloss,
      });
    }

    res.json({ found: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------
// Dictionary API: batch lookup words (for prefetch clickable words)
// Exact match only — fast, no fuzzy overhead
// ---------------------------------------------------------------------
app.post("/api/dict/lookup-batch", async (req, res) => {
  const words = req.body.words;
  const dir = String(req.body.direction || "").toUpperCase();

  if (!Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ error: "Missing 'words' array." });
  }
  if (!["DE_SR", "SR_DE"].includes(dir)) {
    return res
      .status(400)
      .json({ error: "Invalid direction. Use DE_SR or SR_DE." });
  }

  const cleaned = [
    ...new Set(
      words
        .map((w) => String(w).trim().toLowerCase())
        .filter(Boolean)
    ),
  ].slice(0, 200);

  if (cleaned.length === 0) {
    return res.json({ results: {} });
  }

  try {
    const r = await query(
      `SELECT id, headword, main_gloss
       FROM public.entries
       WHERE direction = $1
         AND lower(headword) = ANY($2)`,
      [dir, cleaned]
    );

    const rows = r.rows || r;
    const results = {};
    for (const row of rows) {
      const key = row.headword.toLowerCase();
      if (!results[key]) {
        results[key] = {
          id: row.id,
          headword: row.headword,
          main_gloss: row.main_gloss,
        };
      }
    }

    res.json({ results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------
// API: Gender Drill (like your test sheet)
// ---------------------------------------------------------------------
app.get("/api/game/gender-drill", async (req, res) => {
  const limit = clampInt(req.query.limit, 3, 30, 10);

  // Balanced split, e.g. 10 -> 4/3/3
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
    const result = await query(sql, [derN, dieN, dasN]);
    const rows = result.rows || result; // tolerate different return shapes
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");

    res.json({
      mode: "gender_drill",
      title: "der, das oder die? Ergänzen Sie.",
      items: rows.slice(0, limit).map((r, i) => ({
        letter: letters[i],
        id: r.id,
        headword: r.headword,
        answer: r.gender, // dev mode; later hide answers + grade on server
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------
// Drag & Drop Lessons API
// ---------------------------------------------------------------------

// GET /api/lessons — lista svih lekcija, grupisana po kategoriji
app.get("/api/lessons", async (req, res) => {
  try {
    const r = await query(
      `SELECT id, slug, title, image_path, lang, category, created_at
       FROM public.dd_lessons
       ORDER BY category, created_at DESC`
    );
    const rows = r.rows || r;

    // Grupiši po kategoriji
    const grouped = {};
    for (const row of rows) {
      const cat = row.category || "Ostalo";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(row);
    }

    res.json(grouped);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/lessons/:slug — jedna lekcija sa zonama
app.get("/api/lessons/:slug", async (req, res) => {
  try {
    const lessonR = await query(
      `SELECT id, slug, title, image_path, lang, category
       FROM public.dd_lessons
       WHERE slug = $1`,
      [req.params.slug]
    );
    const rows = lessonR.rows || lessonR;
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Lekcija nije pronađena." });
    }
    const lesson = rows[0];

    const zonesR = await query(
      `SELECT zone_key AS id, de, sr, poly
       FROM public.dd_zones
       WHERE lesson_id = $1
       ORDER BY sort_order`,
      [lesson.id]
    );
    const zones = (zonesR.rows || zonesR).map(z => ({
      id: z.id,
      de: z.de,
      sr: z.sr,
      poly: z.poly,
    }));

    res.json({ ...lesson, zones });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/lessons — sačuvaj novu lekciju (iz editora)
app.post("/api/lessons", async (req, res) => {
  const { slug, title, image_path, lang, category, zones } = req.body;

  if (!slug || !title || !zones || !Array.isArray(zones)) {
    return res.status(400).json({ error: "Nedostaju polja: slug, title, zones." });
  }

  try {
    // Upsert lekcije
    const lessonR = await query(
      `INSERT INTO public.dd_lessons (slug, title, image_path, lang, category)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE
         SET title = EXCLUDED.title,
             image_path = EXCLUDED.image_path,
             lang = EXCLUDED.lang,
             category = EXCLUDED.category
       RETURNING id`,
      [slug, title, image_path || null, lang || "DE_SR", category || null]
    );
    const lessonId = (lessonR.rows || lessonR)[0].id;

    // Obrisi stare zone i upiši nove
    await query(`DELETE FROM public.dd_zones WHERE lesson_id = $1`, [lessonId]);

    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      await query(
        `INSERT INTO public.dd_zones (lesson_id, zone_key, de, sr, poly, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [lessonId, z.id, z.de, z.sr, JSON.stringify(z.poly), i]
      );
    }

    res.json({ ok: true, lesson_id: lessonId, slug });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Render sets PORT for web services; keep local override too.
const port = process.env.PORT || process.env.GAMES_PORT || 3100;

app.listen(port, () => {
  console.log(`Games server: http://localhost:${port}`);
  console.log(`Open: http://localhost:${port}/gender-drill.html`);
});