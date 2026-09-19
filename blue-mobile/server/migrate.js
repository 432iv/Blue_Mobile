"use strict";
/* Migration runner: applies server/migrations/*.sql once each, in order.
   Usage:  npm run migrate                                                */
const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

const DIR = path.join(__dirname, "migrations");

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const applied = new Set(
    (await pool.query("SELECT filename FROM schema_migrations")).rows.map(r => r.filename)
  );
  const files = fs.readdirSync(DIR).filter(f => f.endsWith(".sql")).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) { console.log(`  = ${file} (already applied)`); continue; }
    const sql = fs.readFileSync(path.join(DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`  + ${file} applied`);
      count++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`  ! ${file} FAILED: ${err.message}`);
      client.release();
      await pool.end();
      process.exit(1);
    }
    client.release();
  }
  console.log(count ? `\nMigrations complete (${count} new).` : "\nDatabase already up to date.");
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
