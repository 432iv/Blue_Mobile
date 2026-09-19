"use strict";
/* PostgreSQL connection pool — the only place that talks to the database. */
const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.ssl,
  max: 10,
  idleTimeoutMillis: 30000
});

pool.on("error", err => console.error("[db] idle client error:", err.message));

/* NUMERIC comes back from pg as a string; the ledger wants real numbers. */
const types = require("pg").types;
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));  // numeric
types.setTypeParser(20,   v => (v === null ? null : parseInt(v, 10))); // int8
types.setTypeParser(1082, v => v);                                     // date -> 'YYYY-MM-DD'

async function query(text, params) {
  return pool.query(text, params);
}

/* Run a set of statements inside one transaction. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
