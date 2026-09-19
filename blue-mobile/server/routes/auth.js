"use strict";
/* -------------------------------------------------------------------
   /api/auth — ONE account only.

   * /setup works exactly once: while no account exists. After that it
     answers 409 and the UI never shows a sign-up form again.
   * /login issues a server-side session.
   * There is deliberately no public registration endpoint.
   ------------------------------------------------------------------- */
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const config = require("../config");
const { wrap, cleanText, HttpError } = require("../lib/http");
const auth = require("../middleware/auth");

const router = express.Router();

/* --- crude but effective brute-force brake (per process) --- */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000, MAX_ATTEMPTS = 10;
function throttle(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, first: now };
  if (now - rec.first > WINDOW_MS) { rec.n = 0; rec.first = now; }
  rec.n++;
  attempts.set(key, rec);
  if (rec.n > MAX_ATTEMPTS) throw new HttpError(429, "too_many_attempts", "Too many attempts, try again later");
}
const clearThrottle = key => attempts.delete(key);

const publicUser = u => ({ id: String(u.id), username: u.username, email: u.email, createdAt: u.created_at });

/* Is the app set up yet, and is this caller signed in? */
router.get("/status", wrap(async (req, res) => {
  const exists = await auth.accountExists();
  res.json({
    setupRequired: !exists,
    signupDisabled: exists,          // the UI hides "create account" once true
    authenticated: !!req.user,
    user: req.user ? publicUser(req.user) : null
  });
}));

/* One-time account creation. */
router.post("/setup", wrap(async (req, res) => {
  if (await auth.accountExists()) {
    throw new HttpError(409, "account_exists", "An account already exists — sign in instead");
  }
  const username = cleanText(req.body.username, { field: "username", max: 60 });
  const email = req.body.email ? cleanText(req.body.email, { field: "email", max: 160 }) : null;
  const password = String(req.body.password || "");

  if (username.length < 3) throw new HttpError(400, "username_too_short", "Username needs 3+ characters");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "email_invalid", "Invalid email");
  if (password.length < 8) throw new HttpError(400, "password_too_short", "Password needs 8+ characters");

  const hash = await bcrypt.hash(password, config.bcryptRounds);
  let user;
  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3)
       RETURNING id, username, email, created_at`, [username, email, hash]);
    user = rows[0];
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, "account_exists", "An account already exists");
    throw err;
  }
  await db.query("INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [user.id]);

  const { token, expires } = await auth.createSession(user.id, req.get("user-agent"));
  auth.setSessionCookie(req, res, token, expires);
  res.status(201).json({ user: publicUser(user), token });
}));

/* Sign in with the username or the email. */
router.post("/login", wrap(async (req, res) => {
  const identifier = cleanText(req.body.username || req.body.email || "", { field: "username", max: 160 });
  const password = String(req.body.password || "");
  const key = (req.ip || "ip") + "|" + identifier.toLowerCase();
  throttle(key);

  const { rows } = await db.query(
    `SELECT * FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1`, [identifier]);
  const user = rows[0];
  /* always run a hash comparison so timing does not reveal existence */
  const ok = await bcrypt.compare(password, user ? user.password_hash : "$2a$12$0000000000000000000000000000000000000000000000000000");
  if (!user || !ok) throw new HttpError(401, "invalid_credentials", "Wrong username or password");

  clearThrottle(key);
  const { token, expires } = await auth.createSession(user.id, req.get("user-agent"));
  auth.setSessionCookie(req, res, token, expires);
  res.json({ user: publicUser(user), token });
}));

router.post("/logout", wrap(async (req, res) => {
  await auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
}));

/* Who am I? (used on every app boot) */
router.get("/me", auth.requireAuth, wrap(async (req, res) => {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND expires_at > now()", [req.user.id]);
  res.json({ user: publicUser(req.user), activeSessions: rows[0].n });
}));

/* Change the password of the single account (all other devices stay signed in). */
router.post("/password", auth.requireAuth, wrap(async (req, res) => {
  const current = String(req.body.currentPassword || "");
  const next = String(req.body.newPassword || "");
  if (next.length < 8) throw new HttpError(400, "password_too_short", "Password needs 8+ characters");
  const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!await bcrypt.compare(current, rows[0].password_hash)) {
    throw new HttpError(401, "invalid_credentials", "Current password is wrong");
  }
  const hash = await bcrypt.hash(next, config.bcryptRounds);
  await db.query("UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2", [hash, req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
