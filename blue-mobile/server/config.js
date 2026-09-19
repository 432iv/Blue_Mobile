"use strict";
/* Environment configuration — everything sensitive comes from .env */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] Missing required environment variable: ${name}\n` +
                  `         Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const config = {
  databaseUrl:  required("DATABASE_URL"),
  sessionSecret: required("SESSION_SECRET"),
  port:         parseInt(process.env.PORT || "3000", 10),
  sessionTtlDays: parseInt(process.env.SESSION_TTL_DAYS || "30", 10),
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || "12", 10),
  nodeEnv:      process.env.NODE_ENV || "development",
  ssl:          (process.env.PGSSLMODE || "disable") === "require" ? { rejectUnauthorized: false } : false
};

if (config.sessionSecret.length < 24) {
  console.error("[config] SESSION_SECRET is too short — use at least 24 random characters.");
  process.exit(1);
}

module.exports = config;
