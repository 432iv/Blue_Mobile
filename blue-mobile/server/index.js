"use strict";
/* ===================================================================
   Blue Mobile — Sales Ledger : HTTP server
   Serves the single-page frontend and the /api it talks to.
   Frontend  ->  Express API  ->  PostgreSQL
   =================================================================== */
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");

const config = require("./config");
const db = require("./db");
const auth = require("./middleware/auth");
const { HttpError } = require("./lib/http");

const app = express();
app.set("trust proxy", 1);                 // preview/proxy sets X-Forwarded-Proto
app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

/* ---- baseline security headers (no external CDN except Google Fonts) ---- */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors *");
  next();
});
/* the live preview embeds the app in an iframe from another origin */
app.use((_req, res, next) => { res.removeHeader("X-Frame-Options"); next(); });

app.use(auth.attachUser);

/* ---------------- API ---------------- */
const api = express.Router();
api.get("/health", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ ok: true, db: "up", time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, db: "down", error: e.message });
  }
});

api.use("/auth", require("./routes/auth"));

/* everything below this line requires the single account to be signed in */
api.use(auth.requireAuth);
api.use("/sales",     require("./routes/sales"));
api.use("/products",  require("./routes/products"));     /* قاموس أسماء الإكمال التلقائي (قديم ومحفوظ) */
api.use("/inventory", require("./routes/inventory"));    /* المخزون: منتجات/تصنيفات/وحدات/جرد */
api.use("/purchases", require("./routes/purchases"));    /* المشتريات */
api.use("/expenses",  require("./routes/expenses"));     /* المصروفات */
api.use("/cashbox",   require("./routes/cashbox"));      /* الصندوق */
api.use("/notes",     require("./routes/notes"));
api.use("/days",      require("./routes/days"));
api.use("/reports",   require("./routes/reports"));      /* لوحة التحكم والتقارير */
api.use("/",          require("./routes/data"));         /* settings, bootstrap, backup, data */

api.use((_req, _res, next) => next(new HttpError(404, "not_found", "Unknown endpoint")));
app.use("/api", api);

/* ---------------- frontend ---------------- */
const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "Blue-Mobile.html");
app.get("/", (_req, res) => res.sendFile(INDEX));
app.get("/index.html", (_req, res) => res.redirect("/"));
/* التطبيق فقط هو العام — كود الخادم وملف البيانات وغيرها لا تُقدَّم إطلاقاً */
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) {
    return res.sendFile(INDEX);
  }
  next();
});

/* ---------------- errors ---------------- */
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error("[api]", req.method, req.originalUrl, err);
  res.status(status).json({
    error: err.code || "server_error",
    message: status >= 500 && config.nodeEnv === "production" ? "Server error" : err.message
  });
});

/* ---------------- start ---------------- */
async function start() {
  await db.query("SELECT 1");                       // fail fast if the DB is unreachable
  await auth.purgeExpiredSessions();
  setInterval(() => auth.purgeExpiredSessions().catch(() => {}), 6 * 3600 * 1000).unref();

  const { rows } = await db.query("SELECT count(*)::int AS n FROM users");
  app.listen(config.port, "0.0.0.0", () => {
    console.log(`Blue Mobile ledger listening on 0.0.0.0:${config.port}  [${config.nodeEnv}]`);
    console.log(rows[0].n === 0
      ? "No account yet — open the app to create the single account."
      : "Account ready — open the app and sign in.");
  });
}

if (require.main === module) {
  start().catch(err => { console.error("[startup]", err.message); process.exit(1); });
}
module.exports = app;
