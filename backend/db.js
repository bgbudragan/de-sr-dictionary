const { Pool } = require("pg");

let pool;

if (process.env.DATABASE_URL) {
  // Render / produkcija
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
} else {
  // Lokalno
  pool = new Pool({
    host: "localhost",
    port: 5432,
    database: "dictionary_db",
    user: "postgres",
    password: "",
  });
}

module.exports = pool;