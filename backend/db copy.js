const { Pool } = require("pg");

// OVO prilagodi svojim lokalnim parametrima ako treba
const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "dictionary_db",
  user: "postgres",   // promeni ako imaš drugi user
  password: ""        // ako imaš lozinku, upiši je ovde
});

module.exports = pool;
