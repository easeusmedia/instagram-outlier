import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import disposableDomains from 'disposable-email-domains/index.json' with { type: 'json' };
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tunables ---------------------------------------------------------
// 15 was too shallow to rank "top 15 by outlier score" honestly — a
// creator's highest-viewed reel is often months old, so a chronological
// 15-reel window only ever contains their *recent* videos, never their
// true best. Verified live: whysaksham's real top-15-by-views included 7
// reels from March–May that a 15-or-27-deep cache never had. 60 is a
// tested middle ground (confirmed to surface every real top-15 entry for
// two different creators) — accounts with a much deeper viral history
// than that still get shortchanged; "Load More" extends past it.
const REELS_LIMIT = 60; // initial load, and the "Load More" batch size
const REEL_ACTOR = 'apify~instagram-reel-scraper';
const PROFILE_ACTOR = 'apify~instagram-profile-scraper';
const TRANSCRIPT_ACTOR = 'apple_yang~instagram-transcripts-scraper';
const APIFY_TOKEN_ENV = process.env.APIFY_TOKEN || '';
const PORT = process.env.PORT || 3000;
// How often a cache hit is allowed to trigger a full background re-scrape,
// per creator. Bounds API cost from repeat searches of the same profile
// while still keeping view/like counts (which only change on a full
// re-scrape, not a lighter check) from going stale indefinitely.
const REFRESH_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // once a week
// ------------------------------------------------------------------------

// --- login: email/password accounts + optional Google OAuth ------------
// Email/password is now the primary account system (users table). Google
// OAuth stays available side-by-side when GOOGLE_CLIENT_ID/SECRET are set —
// either path sets the same signed `session` cookie, so everything past
// login (the auth gate below, /api/me) doesn't care which one was used.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
// ponytail: regenerated on every boot if unset, which logs everyone out on
// deploy/restart. Set SESSION_SECRET in the environment to persist sessions.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_ENABLED = true;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DISPOSABLE_DOMAINS = new Set(disposableDomains);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isDisposableEmail(email) {
  return DISPOSABLE_DOMAINS.has((email.split('@')[1] || '').toLowerCase());
}
// scrypt (Node stdlib) over a random per-password salt — no bcrypt
// dependency needed for this.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const target = Buffer.from(hash, 'hex');
  return candidate.length === target.length && crypto.timingSafeEqual(candidate, target);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').filter(Boolean).map((part) => {
    const i = part.indexOf('=');
    return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }));
}
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}
function makeSessionCookie(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_MAX_AGE_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function verifySessionCookie(cookie) {
  if (!cookie) return null;
  const [payload, sig] = cookie.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data.email : null;
  } catch {
    return null;
  }
}
function oauthRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}/auth/google/callback`;
}
// ------------------------------------------------------------------------

// Postgres (e.g. Neon). DATABASE_URL is required — no more local-SQLite
// fallback now that the app has real user accounts and pgvector search.
if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL. Set it to a Postgres connection string (e.g. from neon.tech) in .env.');
  process.exit(1);
}

const { Pool } = pg;
// Neon's connection string ships with `?sslmode=require` — harmless, but
// pg-connection-string prints a deprecation warning on every single parse
// of any sslmode value other than verify-full, regardless of the explicit
// `ssl` option below actually being what's used. We manage TLS ourselves,
// so drop the query param at the source instead of eating that warning on
// every boot.
const dbUrl = new URL(process.env.DATABASE_URL);
dbUrl.searchParams.delete('sslmode');
const pool = new Pool({
  connectionString: dbUrl.toString(),
  // Neon (and most hosted Postgres) terminate TLS with a cert chain `pg`
  // doesn't validate by default; a plain local Postgres has no TLS at all.
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
});

// Every call site in this file was written for SQLite's `?` placeholders —
// converting to Postgres's `$1,$2,...` here, in one place, means none of
// them had to change.
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function run(sql, args = []) {
  return pool.query(toPgSql(sql), args);
}

async function queryOne(sql, args = []) {
  const result = await pool.query(toPgSql(sql), args);
  return result.rows[0] || null;
}

async function queryAll(sql, args = []) {
  const result = await pool.query(toPgSql(sql), args);
  return result.rows;
}

// JSON-typed columns stay TEXT: every call site already does its own
// JSON.parse/stringify, and Postgres's `pg` driver auto-parses a real `json`
// column into an object before that code ever sees it — TEXT sidesteps that
// mismatch without touching any of those call sites.
await run(`CREATE EXTENSION IF NOT EXISTS vector`);
await run(`CREATE TABLE IF NOT EXISTS creators (handle TEXT PRIMARY KEY, profile TEXT)`);
await run(`CREATE TABLE IF NOT EXISTS reels (handle TEXT PRIMARY KEY, data TEXT)`);
await run(`CREATE TABLE IF NOT EXISTS bookmarks (handle TEXT PRIMARY KEY, added_at TEXT, category_id INTEGER)`);
// A creator can belong to more than one category (v1's manage-categories
// modal needs this); bookmarks.category_id above is kept as-is and still
// drives the base app's single-category drag-and-drop UI unchanged — it's
// always kept equal to this table's lowest category_id per handle.
await run(`CREATE TABLE IF NOT EXISTS bookmark_categories (handle TEXT NOT NULL, category_id INTEGER NOT NULL, PRIMARY KEY (handle, category_id))`);
await run(`INSERT INTO bookmark_categories (handle, category_id) SELECT handle, category_id FROM bookmarks WHERE category_id IS NOT NULL ON CONFLICT DO NOTHING`);
await run(`CREATE TABLE IF NOT EXISTS transcripts (shortcode TEXT PRIMARY KEY, data TEXT)`);
await run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
await run(`CREATE TABLE IF NOT EXISTS creator_categories (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
await run(`CREATE TABLE IF NOT EXISTS video_categories (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
await run(`CREATE TABLE IF NOT EXISTS video_tags (shortcode TEXT PRIMARY KEY, category_id INTEGER)`);
await run(`CREATE TABLE IF NOT EXISTS saved_videos (shortcode TEXT PRIMARY KEY, saved_at TEXT)`);
// embedding: OpenAI text-embedding-3-small (1536 dims) over each script's
// content, filled in lazily by embedText() — see the pgvector search block
// near the bottom of the file. NULL until OPENAI_API_KEY is set.
await run(`CREATE TABLE IF NOT EXISTS scripts (id SERIAL PRIMARY KEY, shortcode TEXT, handle TEXT, content TEXT, created_at TEXT, embedding vector(1536))`);
await run(`CREATE TABLE IF NOT EXISTS creator_checks (handle TEXT PRIMARY KEY, checked_at TEXT)`);
// v1 canvas: a "space" is one named Drawflow board. canvas_state is
// whatever editor.export() produced last, saved back verbatim.
await run(`CREATE TABLE IF NOT EXISTS spaces (id SERIAL PRIMARY KEY, name TEXT NOT NULL, canvas_state TEXT, created_at TEXT)`);
// Each v1 space gets its own independent tracked-creator list instead of
// sharing one global pool — without this, a brand new space (or someone
// else's space) showed every creator ever tracked anywhere. space_id 0
// means "no space" — the base app (public/index.html), which has no space
// concept at all, keeps behaving exactly as it always has, unscoped.
// Dropping+re-adding the PK on every boot is wasteful but harmless at this
// table size, and far simpler than a one-time-only guard.
await run(`ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS space_id INTEGER NOT NULL DEFAULT 0`);
await run(`ALTER TABLE bookmarks DROP CONSTRAINT IF EXISTS bookmarks_pkey`);
await run(`ALTER TABLE bookmarks ADD PRIMARY KEY (space_id, handle)`);
await run(`ALTER TABLE bookmark_categories ADD COLUMN IF NOT EXISTS space_id INTEGER NOT NULL DEFAULT 0`);
await run(`ALTER TABLE bookmark_categories DROP CONSTRAINT IF EXISTS bookmark_categories_pkey`);
await run(`ALTER TABLE bookmark_categories ADD PRIMARY KEY (space_id, handle, category_id)`);
await run(`ALTER TABLE creator_categories ADD COLUMN IF NOT EXISTS space_id INTEGER NOT NULL DEFAULT 0`);
await run(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN NOT NULL DEFAULT FALSE, created_at TEXT NOT NULL)`);
// Added after the table already existed in production — ADD COLUMN IF NOT
// EXISTS patches it in place instead of needing a separate migration flag.
await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`);
// FALSE only for accounts that have never actually set a password (Google-
// only logins, upserted with a random unusable placeholder hash below) —
// lets /api/account/password skip the "confirm current password" check for
// those, since Google's own login already proved identity this session.
await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS has_password BOOLEAN NOT NULL DEFAULT TRUE`);

// Seeds one admin account from env vars (never hardcode real credentials in
// source — this repo is version-controlled). Set ADMIN_EMAIL/ADMIN_PASSWORD
// in .env locally and in Render's dashboard; no-ops if either is unset or
// the account already exists.
async function seedAdminUser() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return;
  if (await queryOne('SELECT id FROM users WHERE email = ?', [email])) return;
  await run('INSERT INTO users (email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)', [
    email, hashPassword(password), true, new Date().toISOString(),
  ]);
  console.log(`Seeded admin user: ${email}`);
}
await seedAdminUser();

// Script Generator's LLM call is a plain OpenAI-compatible chat completion,
// so any provider with that API shape works by just changing base URL/model.
// Groq's free tier hosts fast open-source models, so it's the default.
const LLM_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const LLM_DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const SCRIPT_SYSTEM_PROMPT = "You are the world's best viral scriptwriter. You will be given transcripts of one or more videos that already went viral. Study their hooks, pacing, structure, and ideas, then write one new, original short-form video script that applies those same techniques as effectively as possible. Use them as inspiration, not something to copy verbatim. Output only the finished script — no notes, no preamble.";

async function getApifyToken() {
  const row = await queryOne("SELECT value FROM settings WHERE key = 'apifyApiKey'");
  return (row && row.value) || APIFY_TOKEN_ENV;
}

if (!(await getApifyToken())) {
  console.error('Missing Apify token. Copy .env.example to .env and paste your Apify token.');
  process.exit(1);
}

async function getCreatorProfile(handle) {
  const row = await queryOne('SELECT profile FROM creators WHERE handle = ?', [handle]);
  return row ? JSON.parse(row.profile) : null;
}

async function getCreatorReels(handle) {
  const row = await queryOne('SELECT data FROM reels WHERE handle = ?', [handle]);
  return row ? JSON.parse(row.data) : null;
}

async function upsertCreator(handle, profile) {
  await run(
    'INSERT INTO creators (handle, profile) VALUES (?, ?) ON CONFLICT(handle) DO UPDATE SET profile = excluded.profile',
    [handle, JSON.stringify(profile)]
  );
}

async function getLastCheckedAt(handle) {
  const row = await queryOne('SELECT checked_at FROM creator_checks WHERE handle = ?', [handle]);
  return row ? new Date(row.checked_at).getTime() : 0;
}

async function markChecked(handle) {
  await run(
    'INSERT INTO creator_checks (handle, checked_at) VALUES (?, ?) ON CONFLICT(handle) DO UPDATE SET checked_at = excluded.checked_at',
    [handle, new Date().toISOString()]
  );
}

async function upsertReels(handle, reels) {
  await run(
    'INSERT INTO reels (handle, data) VALUES (?, ?) ON CONFLICT(handle) DO UPDATE SET data = excluded.data',
    [handle, JSON.stringify(reels)]
  );
}

// spaceId defaults to 0 everywhere below — the base app (public/index.html)
// has no concept of spaces at all and never passes one, so it always reads
// and writes the space_id=0 bucket, unchanged from before this existed.
// Each v1 space passes its own real id, keeping its tracked creators and
// categories independent of every other space.
async function isBookmarked(handle, spaceId = 0) {
  return !!(await queryOne('SELECT 1 FROM bookmarks WHERE handle = ? AND space_id = ?', [handle, spaceId]));
}

async function listBookmarks(spaceId = 0) {
  const [rows, catRows] = await Promise.all([
    queryAll('SELECT handle, added_at FROM bookmarks WHERE space_id = ? ORDER BY added_at', [spaceId]),
    queryAll('SELECT handle, category_id FROM bookmark_categories WHERE space_id = ? ORDER BY category_id', [spaceId]),
  ]);
  const catsByHandle = new Map();
  for (const r of catRows) {
    if (!catsByHandle.has(r.handle)) catsByHandle.set(r.handle, []);
    catsByHandle.get(r.handle).push(r.category_id);
  }
  return Promise.all(
    rows.map(async (row) => {
      const categoryIds = catsByHandle.get(row.handle) || [];
      return {
        handle: row.handle,
        addedAt: row.added_at,
        categoryId: categoryIds[0] ?? null, // back-compat: base app's single-category UI
        categoryIds, // full membership, used by v1's multi-category manage modal
        profile: await getCreatorProfile(row.handle),
      };
    })
  );
}

// Keeps bookmarks.category_id (the base app's single-category column) equal
// to the lowest id in bookmark_categories, so nothing there needs to change.
async function syncPrimaryCategoryColumn(handle, spaceId = 0) {
  const row = await queryOne('SELECT MIN(category_id) AS id FROM bookmark_categories WHERE handle = ? AND space_id = ?', [handle, spaceId]);
  await run('UPDATE bookmarks SET category_id = ? WHERE handle = ? AND space_id = ?', [row?.id ?? null, handle, spaceId]);
}

// Replaces a creator's category membership with exactly one category — this
// is what the base app's drag-and-drop ("move this chip to that section")
// UI calls, so it keeps that replace-not-add semantics.
async function setBookmarkCategory(handle, categoryId, spaceId = 0) {
  await run('DELETE FROM bookmark_categories WHERE handle = ? AND space_id = ?', [handle, spaceId]);
  if (categoryId != null) await run('INSERT INTO bookmark_categories (handle, category_id, space_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [handle, categoryId, spaceId]);
  await syncPrimaryCategoryColumn(handle, spaceId);
}

// Replaces a creator's category membership with an arbitrary set — this is
// what v1's manage-categories modal uses to put one creator in several
// categories at once.
async function setBookmarkCategories(handle, categoryIds, spaceId = 0) {
  await run('DELETE FROM bookmark_categories WHERE handle = ? AND space_id = ?', [handle, spaceId]);
  for (const id of categoryIds) {
    await run('INSERT INTO bookmark_categories (handle, category_id, space_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [handle, id, spaceId]);
  }
  await syncPrimaryCategoryColumn(handle, spaceId);
}

// --- creator categories ----------------------------------------------------
// listCategories/createCategory are also shared with video_categories
// (which has no space_id column at all — per-video tags aren't spaced),
// hence the table-name branch instead of just always filtering.

async function listCategories(table, spaceId = 0) {
  return table === 'creator_categories'
    ? queryAll(`SELECT id, name FROM ${table} WHERE space_id = ? ORDER BY id`, [spaceId])
    : queryAll(`SELECT id, name FROM ${table} ORDER BY id`);
}

async function createCategory(table, name, spaceId = 0) {
  if (table === 'creator_categories') await run(`INSERT INTO ${table} (name, space_id) VALUES (?, ?)`, [name, spaceId]);
  else await run(`INSERT INTO ${table} (name) VALUES (?)`, [name]);
  return listCategories(table, spaceId);
}

async function renameCategory(table, id, name, spaceId = 0) {
  await run(`UPDATE ${table} SET name = ? WHERE id = ?`, [name, id]);
  return listCategories(table, spaceId);
}

async function deleteCreatorCategory(id) {
  const rows = await queryAll('SELECT handle, space_id FROM bookmark_categories WHERE category_id = ?', [id]);
  await run('DELETE FROM bookmark_categories WHERE category_id = ?', [id]);
  await run('UPDATE bookmarks SET category_id = NULL WHERE category_id = ?', [id]);
  await run('DELETE FROM creator_categories WHERE id = ?', [id]);
  await Promise.all(rows.map((r) => syncPrimaryCategoryColumn(r.handle, r.space_id)));
}

// --- video categories + per-video bookmarks (independent of creator categories) --

async function deleteVideoCategory(id) {
  await run('DELETE FROM video_tags WHERE category_id = ?', [id]);
  await run('DELETE FROM video_categories WHERE id = ?', [id]);
}

async function getVideoTags() {
  const rows = await queryAll('SELECT shortcode, category_id FROM video_tags');
  return rows.reduce((acc, row) => {
    acc[row.shortcode] = row.category_id;
    return acc;
  }, {});
}

async function setVideoTag(shortcode, categoryId) {
  if (categoryId == null) {
    await run('DELETE FROM video_tags WHERE shortcode = ?', [shortcode]);
  } else {
    await run(
      'INSERT INTO video_tags (shortcode, category_id) VALUES (?, ?) ON CONFLICT(shortcode) DO UPDATE SET category_id = excluded.category_id',
      [shortcode, categoryId]
    );
  }
}

async function getSavedVideos() {
  const rows = await queryAll('SELECT shortcode FROM saved_videos');
  return rows.map((row) => row.shortcode);
}

async function setVideoSaved(shortcode, saved) {
  if (saved) {
    await run(
      'INSERT INTO saved_videos (shortcode, saved_at) VALUES (?, ?) ON CONFLICT(shortcode) DO NOTHING',
      [shortcode, new Date().toISOString()]
    );
  } else {
    await run('DELETE FROM saved_videos WHERE shortcode = ?', [shortcode]);
    await run('DELETE FROM video_tags WHERE shortcode = ?', [shortcode]);
  }
}

// Excludes `embedding` deliberately — it's a 1536-float array, no caller of
// listScripts needs it, and shipping it in every response would bloat the
// payload for nothing.
async function listScripts() {
  return queryAll('SELECT id, shortcode, handle, content, created_at FROM scripts ORDER BY created_at DESC');
}

async function addScript(shortcode, handle, content) {
  const existing = await queryOne('SELECT id FROM scripts WHERE shortcode = ?', [shortcode]);
  if (!existing) {
    const row = await queryOne(
      'INSERT INTO scripts (shortcode, handle, content, created_at) VALUES (?, ?, ?, ?) RETURNING id',
      [shortcode, handle, content, new Date().toISOString()]
    );
    // Fire-and-forget: embedding is for search, never something a script-add
    // request should wait on. No-ops silently if OPENAI_API_KEY isn't set.
    embedText(content).then((vec) => {
      if (vec) return run('UPDATE scripts SET embedding = ? WHERE id = ?', [vecLiteral(vec), row.id]);
    }).catch((err) => console.error('Embedding failed for script', row.id, err.message));
  }
  return listScripts();
}

// --- pgvector semantic search over saved scripts -----------------------
// Groq (the default Script Genie LLM) has no embeddings endpoint, so this
// uses OpenAI directly via a plain env var rather than the Settings-modal
// LLM key. Every call site is written to no-op (return null) when unset —
// scripts just stay unembedded and /api/search reports why, instead of the
// app crashing for anyone who hasn't wired this up.
const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dims, matches the scripts.embedding column

async function embedText(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !text) return null;
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.data?.[0]?.embedding || null;
}
// pgvector reads its column type off the target column, so a plain
// bracketed-number-list string (its native text input format) is all a
// query parameter needs to be — no special pg type wiring required.
function vecLiteral(vec) {
  return `[${vec.join(',')}]`;
}

async function getLlmSettings() {
  const rows = await queryAll("SELECT key, value FROM settings WHERE key IN ('llmBaseUrl', 'llmApiKey', 'llmModel')");
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    baseUrl: byKey.llmBaseUrl || LLM_DEFAULT_BASE_URL,
    apiKey: byKey.llmApiKey || '',
    model: byKey.llmModel || LLM_DEFAULT_MODEL,
  };
}

async function addBookmark(handle, spaceId = 0) {
  await run(
    'INSERT INTO bookmarks (handle, added_at, space_id) VALUES (?, ?, ?) ON CONFLICT(space_id, handle) DO NOTHING',
    [handle, new Date().toISOString(), spaceId]
  );
}

async function removeBookmark(handle, spaceId = 0) {
  await run('DELETE FROM bookmarks WHERE handle = ? AND space_id = ?', [handle, spaceId]);
  await run('DELETE FROM bookmark_categories WHERE handle = ? AND space_id = ?', [handle, spaceId]);
}

async function getCachedTranscript(shortcode) {
  const row = await queryOne('SELECT data FROM transcripts WHERE shortcode = ?', [shortcode]);
  return row ? JSON.parse(row.data) : null;
}

async function upsertTranscript(shortcode, data) {
  await run(
    'INSERT INTO transcripts (shortcode, data) VALUES (?, ?) ON CONFLICT(shortcode) DO UPDATE SET data = excluded.data',
    [shortcode, JSON.stringify(data)]
  );
}

// Reels are cached without a transcript (that's a separate, on-demand actor).
// Once a transcript's been fetched once, it lives in the transcripts table —
// this joins it back in so a page refresh doesn't look like it was lost.
async function attachCachedTranscripts(reels) {
  const codes = reels.map((r) => r.shortCode).filter(Boolean);
  if (!codes.length) return reels;
  const placeholders = codes.map(() => '?').join(',');
  const rows = await queryAll(`SELECT shortcode, data FROM transcripts WHERE shortcode IN (${placeholders})`, codes);
  if (!rows.length) return reels;
  const byCode = Object.fromEntries(rows.map((r) => [r.shortcode, JSON.parse(r.data)]));
  return reels.map((r) => (r.transcript ? r : { ...r, transcript: byCode[r.shortCode] || null }));
}

// --- input parsing ------------------------------------------------------

function parseInput(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^@/, '');
  s = s.split('?')[0].split('#')[0];
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  s = s.replace(/\/+$/, '');
  if (/^instagram\.com\//i.test(s)) s = s.slice('instagram.com/'.length);

  const parts = s.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  const kind = parts[0].toLowerCase();
  if (['reel', 'p', 'tv'].includes(kind) && parts[1]) {
    return { type: 'post', kind, code: parts[1] };
  }

  const username = parts[0];
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(username)) return null;
  return { type: 'username', username };
}

// --- apify ----------------------------------------------------------------

async function callApify(actor, input, maxItems) {
  const token = await getApifyToken();
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}&maxItems=${maxItems}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Apify actor ${actor} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function resolveOwnerFromPost(kind, code) {
  const postUrl = `https://www.instagram.com/${kind}/${code}/`;
  const items = await callApify(REEL_ACTOR, { username: [postUrl], resultsLimit: 1 }, 5);
  const owner = items && items[0] && items[0].ownerUsername;
  if (!owner) throw new Error('Could not resolve the account that posted this link.');
  return owner;
}

function numOrNull(v) {
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}

// Linear-interpolation quantile (matches numpy's default / Excel's
// PERCENTILE.INC) — `sorted` must already be ascending.
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

// Instagram (via the scraper) reports two different metrics: videoViewCount
// and videoPlayCount ("plays", counts every replay/autoplay loop) — verified
// directly against Instagram's own grid for a real reel, videoPlayCount is
// the one matching what's actually displayed, and plays >= views always
// (confirmed across a fresh live sample: every reel had videoPlayCount
// roughly 2x videoViewCount, never the reverse). It used to be `play ??
// view` — but the scraper intermittently omits videoPlayCount on an
// otherwise-normal item (confirmed live: a re-scrape of the same reel had
// it present one run and missing the next), and `??` only falls back when
// a field is *entirely absent* — it can't tell "genuinely missing" apart
// from "present but 0", and more importantly a `??` fallback, once it
// picks the smaller videoViewCount for a reel, never self-corrects on a
// later refresh if that refresh happens to hit the same gap. Taking
// whichever of the two is larger whenever both are present is
// self-correcting on every refresh and never displays a number smaller
// than what Instagram itself would show.
function pickViews(it) {
  const play = numOrNull(it.videoPlayCount);
  const view = numOrNull(it.videoViewCount);
  if (play != null && view != null) return Math.max(play, view);
  return play ?? view;
}

function normalizeReelItem(it) {
  const shortCode = it.shortCode || it.shortcode || '';
  return {
    shortCode,
    url: it.url || (shortCode ? `https://www.instagram.com/reel/${shortCode}/` : ''),
    caption: it.caption || '',
    thumbnail: it.displayUrl || it.thumbnailUrl || '',
    videoUrl: it.videoUrl || null,
    views: pickViews(it),
    likes: numOrNull(it.likesCount),
    duration: numOrNull(it.videoDuration),
    timestamp: it.timestamp || null,
    transcript: it.transcript || null,
  };
}

// outlierScore is views ÷ the creator's own median views (over whatever's
// cached) — this is the convention actual reel-outlier tools use (e.g. the
// "Outliers" Chrome extension, and creator-growth writeups defining an
// outlier as a reel clearing 3x the account's median of its last 30):
// simple, and it ranks the way creators actually talk about it ("this is a
// 6x for me"), unlike the IQR-fence version this replaces — that scored
// most of a creator's own best videos under 1.0 (since Q3+1.5*IQR sits
// *above* typical good performance, not at it), so "most outlier video"
// never surfaced as the top result the way a plain views-vs-normal ratio
// does. Median over mean since one viral post shouldn't drag the baseline
// that everything else, including itself, gets judged against.
function computeOutlierScores(normalized) {
  const views = normalized.map((r) => r.views).filter((v) => v != null && v > 0).sort((a, b) => a - b);
  const median = quantile(views, 0.5);
  return normalized.map((r) => ({
    ...r,
    // Uncapped — a reel at 12x its creator's median shows as 12.0×, not
    // flattened to whatever cap used to sit here. Two different reels
    // that both cleared the old 100x ceiling used to render identically;
    // now they show their real, distinguishable multiples.
    outlierScore: median > 0 && r.views != null ? r.views / median : null,
  }));
}

function scoreReels(items) {
  return computeOutlierScores(items.map(normalizeReelItem));
}

// Merge freshly-scraped raw items into an already-normalized cached list,
// keyed by shortCode. Fresh view/like counts win; transcripts are kept from
// whichever side has them. Recomputes outlier scores over the merged set.
function mergeReels(cachedNormalized, freshRawItems) {
  const byCode = new Map(cachedNormalized.map((r) => [r.shortCode, r]));
  freshRawItems.map(normalizeReelItem).forEach((r) => {
    const existing = byCode.get(r.shortCode);
    byCode.set(r.shortCode, { ...r, transcript: r.transcript || existing?.transcript || null });
  });
  const merged = [...byCode.values()].sort(
    (a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)
  );
  return computeOutlierScores(merged);
}

// Fired (not awaited) after a cache-hit response has already gone out, so
// it never slows the request down or makes a repeat search of the same
// profile within the same week pay for anything extra. Re-scrapes the
// creator's full reel batch and merges it into the cache — a full re-scrape
// is what actually refreshes view/like counts on already-cached reels (a
// single-newest-reel check, which is all the old version did, only ever
// catches a brand new upload and never revisits older ones, which is why
// view counts could go stale indefinitely). mergeReels keeps whichever
// side has a transcript already, so nothing cached gets thrown away.
async function refreshCreatorInBackground(handle, cachedReels, limit) {
  try {
    if (Date.now() - (await getLastCheckedAt(handle)) < REFRESH_COOLDOWN_MS) return;
    await markChecked(handle);
    const reelItems = await callApify(REEL_ACTOR, { username: [handle], resultsLimit: limit }, limit);
    await upsertReels(handle, mergeReels(cachedReels, reelItems || []));
  } catch (err) {
    console.error(`Background refresh failed for ${handle}:`, err.message);
  }
}

// --- app --------------------------------------------------------------

const app = express();
// Express's default 100kb limit is easy to hit here specifically: a
// space's canvas_state includes every node's *rendered* HTML (not just
// data), and a handful of group-nodes each holding several videos'
// thumbnails/captions adds up fast — confirmed live, a space with ~10
// real nodes plus a dozen more comfortably cleared 100kb and got a save
// silently rejected with a generic 413.
app.use(express.json({ limit: '10mb' }));

app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: oauthRedirectUri(req),
    response_type: 'code',
    scope: 'openid email',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const cookies = parseCookies(req);
  if (!code || !state || state !== cookies.oauth_state) {
    return res.status(400).send('Invalid or expired login attempt — go back and try again.');
  }
  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: oauthRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) throw new Error(tokenData.error_description || 'Google token exchange failed.');
    const userResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userResp.json();
    const email = (user.email || '').toLowerCase();
    if (!email || !user.email_verified || (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email))) {
      return res.status(403).send('This Google account is not authorized to use this app.');
    }
    // Ensures a users row exists for every Google login too, so account
    // settings (display name, etc.) have somewhere to persist to. The
    // placeholder password can never be guessed/typed, so /auth/login stays
    // closed for this account until they explicitly set a real password.
    await run(
      'INSERT INTO users (email, password_hash, has_password, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING',
      [email, hashPassword(crypto.randomBytes(32).toString('hex')), false, new Date().toISOString()]
    );
    res.setHeader('Set-Cookie', [
      'oauth_state=; Path=/; Max-Age=0',
      `session=${makeSessionCookie(email)}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}; SameSite=Lax`,
    ]);
    res.redirect('/');
  } catch (err) {
    res.status(500).send(`Login failed: ${err.message}`);
  }
});

function setSessionCookie(res, email) {
  res.setHeader('Set-Cookie', `session=${makeSessionCookie(email)}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}; SameSite=Lax`);
}

app.post('/auth/signup', async (req, res) => {
  const email = ((req.body && req.body.email) || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (isDisposableEmail(email)) return res.status(400).json({ error: 'Temporary/disposable email addresses are not allowed — use a permanent one.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (await queryOne('SELECT id FROM users WHERE email = ?', [email])) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }
  await run('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)', [email, hashPassword(password), new Date().toISOString()]);
  setSessionCookie(res, email);
  res.json({ ok: true, email });
});

app.post('/auth/login', async (req, res) => {
  const email = ((req.body && req.body.email) || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';
  const user = await queryOne('SELECT password_hash FROM users WHERE email = ?', [email]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  setSessionCookie(res, email);
  res.json({ ok: true, email });
});

app.get('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.redirect('/login');
});

app.get('/api/me', (req, res) => {
  const email = AUTH_ENABLED ? verifySessionCookie(parseCookies(req).session) : null;
  res.json({ authEnabled: AUTH_ENABLED, email });
});

function sessionEmail(req) {
  return AUTH_ENABLED ? verifySessionCookie(parseCookies(req).session) : null;
}

app.get('/api/account', async (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error: 'Sign in required.' });
  const user = await queryOne('SELECT name, is_admin, has_password FROM users WHERE email = ?', [email]);
  res.json({ email, name: user?.name || '', isAdmin: !!user?.is_admin, hasPassword: !!user?.has_password });
});

app.patch('/api/account', async (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error: 'Sign in required.' });
  const name = ((req.body && req.body.name) || '').trim();
  await run('UPDATE users SET name = ? WHERE email = ?', [name || null, email]);
  res.json({ ok: true });
});

app.post('/api/account/password', async (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error: 'Sign in required.' });
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const user = await queryOne('SELECT password_hash, has_password FROM users WHERE email = ?', [email]);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  // A Google-only account has never had a real password to confirm —
  // signing in with Google already proved identity for this session.
  if (user.has_password && !verifyPassword(currentPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  await run('UPDATE users SET password_hash = ?, has_password = TRUE WHERE email = ?', [hashPassword(newPassword), email]);
  res.json({ ok: true });
});

app.delete('/api/account', async (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error: 'Sign in required.' });
  const user = await queryOne('SELECT is_admin FROM users WHERE email = ?', [email]);
  if (user?.is_admin) return res.status(403).json({ error: "The admin account can't be deleted." });
  await run('DELETE FROM users WHERE email = ?', [email]);
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

if (AUTH_ENABLED) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path === '/login' || req.path === '/api/me') return next();
    const email = verifySessionCookie(parseCookies(req).session);
    if (email) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required.' });
    res.redirect('/login');
  });
}

// v1 is the homepage for now. Old app still reachable at /index.html.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'v1.html'));
});
app.get('/v1', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'v1.html'));
});

// `extensions: ['html']` is what makes /login resolve to public/login.html
// without a redirect or a dedicated route — a bare .html-less URL reads as
// more polished than instagram-outlier.onrender.com/login.html.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/creator', async (req, res) => {
  try {
    const parsed = parseInput(req.query.input);
    if (!parsed) {
      return res.status(400).json({ error: 'Enter a username, @handle, or an Instagram profile/reel link.' });
    }

    const username = parsed.type === 'post' ? await resolveOwnerFromPost(parsed.kind, parsed.code) : parsed.username;
    const handle = username.toLowerCase();
    const forceRefresh = req.query.refresh === '1';
    const requestedLimit = Math.max(1, parseInt(req.query.limit, 10) || REELS_LIMIT);

    let profile = forceRefresh ? null : await getCreatorProfile(handle);
    let reels = forceRefresh ? null : await getCreatorReels(handle);
    let freshlyScraped = false;

    if (!profile || !reels) {
      // Nothing cached yet (or a forced refresh): scrape from scratch.
      const [profileItems, reelItems] = await Promise.all([
        callApify(PROFILE_ACTOR, { usernames: [handle] }, 1),
        callApify(
          REEL_ACTOR,
          { username: [handle], resultsLimit: requestedLimit },
          requestedLimit
        ),
      ]);

      const p = (profileItems && profileItems[0]) || {};
      profile = {
        handle,
        fullName: p.fullName || handle,
        followersCount: numOrNull(p.followersCount),
        profilePicUrl: p.profilePicUrl || p.profilePicUrlHD || null,
      };
      reels = scoreReels(reelItems || []);

      await upsertCreator(handle, profile);
      await upsertReels(handle, reels);
      freshlyScraped = true;
    } else if (reels.length < requestedLimit) {
      // "Load More": cache doesn't have enough yet, re-scrape at the bigger size.
      const reelItems = await callApify(
        REEL_ACTOR,
        { username: [handle], resultsLimit: requestedLimit },
        requestedLimit
      );
      reels = mergeReels(reels, reelItems || []);
      await upsertReels(handle, reels);
      freshlyScraped = true;
    }
    // else: cache already covers what was asked for — serve it as-is, no
    // Apify call now. A background check (below) looks for new uploads
    // instead, so the response stays instant either way.

    const withTranscripts = await attachCachedTranscripts(reels);
    res.json({ profile, reels: withTranscripts, bookmarked: await isBookmarked(handle, spaceIdOf(req)), hasMore: withTranscripts.length >= requestedLimit });

    if (!freshlyScraped && !forceRefresh) {
      refreshCreatorInBackground(handle, reels, requestedLimit);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// Resolves one specific reel/post link directly — the same Apify call
// resolveOwnerFromPost makes already returns full data for that exact post
// (not just its owner), so this just keeps the rest instead of throwing it
// away. Used by v1's "paste a reel link onto the canvas" so it never has
// to search an owner's recent batch (and fail) to find the pasted reel.
app.get('/api/reel', async (req, res) => {
  try {
    const parsed = parseInput(req.query.input);
    if (!parsed || parsed.type !== 'post') {
      return res.status(400).json({ error: 'Paste a specific reel or post link (not a username).' });
    }
    const postUrl = `https://www.instagram.com/${parsed.kind}/${parsed.code}/`;
    const items = await callApify(REEL_ACTOR, { username: [postUrl], resultsLimit: 1 }, 5);
    const raw = items && items[0];
    if (!raw || !raw.shortCode) throw new Error('Could not load that reel.');
    const handle = (raw.ownerUsername || '').toLowerCase();

    // A single reel has no distribution to score itself against — pull in
    // the rest of its creator's reels (cached, or a fresh scrape if this
    // creator has never been tracked) so the outlier score on a pasted reel
    // means the same thing it does everywhere else: relative to that
    // creator's own other videos, not blank.
    let reels = handle ? await getCreatorReels(handle) : null;
    if (!reels && handle) {
      const reelItems = await callApify(REEL_ACTOR, { username: [handle], resultsLimit: REELS_LIMIT }, REELS_LIMIT);
      reels = scoreReels(reelItems || []);
      await upsertReels(handle, reels);
    }
    const merged = reels ? mergeReels(reels, [raw]) : scoreReels([raw]);
    if (handle) await upsertReels(handle, merged);
    const reel = { ...merged.find((r) => r.shortCode === raw.shortCode), handle };
    const [withTranscript] = await attachCachedTranscripts([reel]);
    res.json({ reel: withTranscript });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// Canvas nodes store a *frozen* copy of a reel's views/outlierScore/likes
// from whenever it was dragged onto the canvas — that's what lets the
// canvas render instantly without a network round-trip per node, but it
// means a node placed weeks ago just sits there silently drifting further
// from reality while the background weekly refresh keeps the underlying
// `reels` cache current (verified: one canvas node was showing 180K views
// for a reel already at 1M+ in the cache). This is the read side of that
// gap: given the handles actually present on a canvas, hand back current
// cached stats keyed by shortCode so the client can patch its frozen nodes
// in place. Pure cache read — no Apify call, so opening a space never costs
// quota — but it also nudges the same weekly-cooldown background refresh
// /api/creator uses, so a creator only ever seen via canvas (never
// re-searched) still keeps refreshing instead of freezing forever.
app.get('/api/reel-stats', async (req, res) => {
  try {
    const handles = String(req.query.handles || '')
      .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    const stats = {};
    for (const handle of handles) {
      const reels = await getCreatorReels(handle);
      if (!reels) continue;
      stats[handle] = {};
      for (const r of reels) {
        stats[handle][r.shortCode] = { views: r.views, outlierScore: r.outlierScore, likes: r.likes };
      }
      refreshCreatorInBackground(handle, reels, reels.length);
    }
    res.json({ stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

app.get('/api/transcript', async (req, res) => {
  try {
    const parsed = parseInput(req.query.input);
    if (!parsed || parsed.type !== 'post') {
      return res.status(400).json({ error: 'Paste a specific reel or post link (not a username) to fetch its transcript.' });
    }

    const cached = req.query.refresh === '1' ? null : await getCachedTranscript(parsed.code);
    if (cached) return res.json({ transcript: cached, cached: true });

    const postUrl = `https://www.instagram.com/${parsed.kind}/${parsed.code}/`;
    const items = await callApify(TRANSCRIPT_ACTOR, { videoUrl: postUrl }, 10);
    const item = items && items[0];
    const transcript = item && item.text;
    if (!transcript) throw new Error((item && item.errMsg) || 'Instagram did not return a transcript for this reel.');

    await upsertTranscript(parsed.code, transcript);
    res.json({ transcript, cached: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// spaceId travels as a query param on GET/DELETE and a body field on
// POST/PATCH — either way, an absent or non-numeric one reads as 0, the
// base app's (space-less) bucket.
function spaceIdOf(req) {
  return parseInt((req.body && req.body.spaceId) ?? req.query.spaceId, 10) || 0;
}

app.get('/api/bookmarks', async (req, res) => {
  res.json({ bookmarks: await listBookmarks(spaceIdOf(req)) });
});

app.post('/api/bookmarks', async (req, res) => {
  const { handle, action } = req.body || {};
  if (!handle || !['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'handle and action ("add" or "remove") are required.' });
  }
  const spaceId = spaceIdOf(req);
  const h = handle.toLowerCase();
  if (action === 'add') {
    if (!(await getCreatorProfile(h))) {
      return res.status(400).json({ error: 'Load this creator on the Add tab first, then bookmark it.' });
    }
    await addBookmark(h, spaceId);
  } else {
    await removeBookmark(h, spaceId);
  }
  res.json({ bookmarks: await listBookmarks(spaceId) });
});

app.post('/api/bookmarks/category', async (req, res) => {
  const { handle, categoryId } = req.body || {};
  if (!handle) return res.status(400).json({ error: 'handle is required.' });
  const spaceId = spaceIdOf(req);
  await setBookmarkCategory(handle.toLowerCase(), categoryId ?? null, spaceId);
  res.json({ bookmarks: await listBookmarks(spaceId) });
});

// Multi-category variant (v1's manage-categories modal) — sets the full
// membership list at once, rather than replacing with a single category.
app.post('/api/bookmarks/categories', async (req, res) => {
  const { handle, categoryIds } = req.body || {};
  if (!handle || !Array.isArray(categoryIds)) return res.status(400).json({ error: 'handle and categoryIds[] are required.' });
  const spaceId = spaceIdOf(req);
  await setBookmarkCategories(handle.toLowerCase(), categoryIds.map(Number), spaceId);
  res.json({ bookmarks: await listBookmarks(spaceId) });
});

function maskApifyKey(token) {
  return token.length <= 8 ? '••••' : `${token.slice(0, 10)}…${token.slice(-4)}`;
}

async function apifyKeyStatus() {
  const token = await getApifyToken();
  const usingOverride = !!(await queryOne("SELECT value FROM settings WHERE key = 'apifyApiKey'"));
  return { masked: token ? maskApifyKey(token) : null, usingOverride };
}

async function testApifyKey(token) {
  const res = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`);
  if (!res.ok) return { valid: false };
  const data = await res.json();
  return { valid: true, username: data?.data?.username || null };
}

app.get('/api/settings/apify-key', async (req, res) => {
  res.json(await apifyKeyStatus());
});

app.post('/api/settings/apify-key/test', async (req, res) => {
  const apiKey = req.body?.apiKey?.trim();
  if (!apiKey) return res.status(400).json({ error: 'API key is required.' });
  try {
    res.json(await testApifyKey(apiKey));
  } catch {
    res.status(500).json({ error: 'Could not reach Apify to test this key.' });
  }
});

app.post('/api/settings/apify-key', async (req, res) => {
  const apiKey = req.body?.apiKey?.trim();
  if (!apiKey) return res.status(400).json({ error: 'API key is required.' });
  await run(
    "INSERT INTO settings (key, value) VALUES ('apifyApiKey', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [apiKey]
  );
  res.json(await apifyKeyStatus());
});

app.delete('/api/settings/apify-key', async (req, res) => {
  await run("DELETE FROM settings WHERE key = 'apifyApiKey'");
  res.json(await apifyKeyStatus());
});

app.get('/api/creator-categories', async (req, res) => {
  res.json({ categories: await listCategories('creator_categories', spaceIdOf(req)) });
});

app.post('/api/creator-categories', async (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  res.json({ categories: await createCategory('creator_categories', name, spaceIdOf(req)) });
});

app.patch('/api/creator-categories/:id', async (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  res.json({ categories: await renameCategory('creator_categories', Number(req.params.id), name, spaceIdOf(req)) });
});

app.delete('/api/creator-categories/:id', async (req, res) => {
  const spaceId = spaceIdOf(req);
  await deleteCreatorCategory(Number(req.params.id));
  res.json({ categories: await listCategories('creator_categories', spaceId), bookmarks: await listBookmarks(spaceId) });
});

app.get('/api/video-categories', async (req, res) => {
  res.json({ categories: await listCategories('video_categories') });
});

app.post('/api/video-categories', async (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  res.json({ categories: await createCategory('video_categories', name) });
});

app.patch('/api/video-categories/:id', async (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  res.json({ categories: await renameCategory('video_categories', Number(req.params.id), name) });
});

app.delete('/api/video-categories/:id', async (req, res) => {
  await deleteVideoCategory(Number(req.params.id));
  res.json({ categories: await listCategories('video_categories'), videoTags: await getVideoTags() });
});

app.get('/api/video-tags', async (req, res) => {
  res.json({ videoTags: await getVideoTags() });
});

app.post('/api/video-tags', async (req, res) => {
  const { shortCode, categoryId } = req.body || {};
  if (!shortCode) return res.status(400).json({ error: 'shortCode is required.' });
  await setVideoTag(shortCode, categoryId ?? null);
  // Filing a video into a category is itself an act of saving it.
  if (categoryId != null) await setVideoSaved(shortCode, true);
  res.json({ videoTags: await getVideoTags(), shortCodes: await getSavedVideos() });
});

app.get('/api/saved-videos', async (req, res) => {
  res.json({ shortCodes: await getSavedVideos() });
});

app.post('/api/saved-videos', async (req, res) => {
  const { shortCode, saved } = req.body || {};
  if (!shortCode) return res.status(400).json({ error: 'shortCode is required.' });
  await setVideoSaved(shortCode, saved !== false);
  res.json({ shortCodes: await getSavedVideos(), videoTags: await getVideoTags() });
});

app.get('/api/scripts', async (req, res) => {
  res.json({ scripts: await listScripts() });
});

app.post('/api/scripts', async (req, res) => {
  const { shortCode, handle, content } = req.body || {};
  if (!shortCode || !content) return res.status(400).json({ error: 'shortCode and content are required.' });
  res.json({ scripts: await addScript(shortCode, handle || '', content) });
});

app.patch('/api/scripts/:id', async (req, res) => {
  const content = (req.body && req.body.content) || '';
  const id = Number(req.params.id);
  await run('UPDATE scripts SET content = ? WHERE id = ?', [content, id]);
  embedText(content).then((vec) => {
    if (vec) return run('UPDATE scripts SET embedding = ? WHERE id = ?', [vecLiteral(vec), id]);
  }).catch((err) => console.error('Embedding failed for script', id, err.message));
  res.json({ scripts: await listScripts() });
});

app.delete('/api/scripts/:id', async (req, res) => {
  await run('DELETE FROM scripts WHERE id = ?', [Number(req.params.id)]);
  res.json({ scripts: await listScripts() });
});

// Semantic search over saved scripts (pgvector cosine distance). Needs
// OPENAI_API_KEY set — see embedText above.
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required.' });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Semantic search needs OPENAI_API_KEY set on the server.' });
  }
  const vec = await embedText(q);
  if (!vec) return res.status(502).json({ error: 'Could not reach OpenAI to embed the search query.' });
  const literal = vecLiteral(vec);
  const results = await queryAll(
    `SELECT id, shortcode, handle, content, created_at, 1 - (embedding <=> ?) AS similarity
     FROM scripts WHERE embedding IS NOT NULL ORDER BY embedding <=> ? LIMIT 20`,
    [literal, literal]
  );
  res.json({ results });
});

// --- v1 canvas: spaces ---------------------------------------------------

app.get('/api/spaces', async (req, res) => {
  const rows = await queryAll('SELECT id, name, created_at FROM spaces ORDER BY id DESC');
  res.json({ spaces: rows });
});

app.post('/api/spaces', async (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const row = await queryOne('INSERT INTO spaces (name, canvas_state, created_at) VALUES (?, ?, ?) RETURNING id', [
    name,
    null,
    new Date().toISOString(),
  ]);
  res.json({ id: row.id });
});

app.get('/api/spaces/:id', async (req, res) => {
  const row = await queryOne('SELECT id, name, canvas_state, created_at FROM spaces WHERE id = ?', [
    Number(req.params.id),
  ]);
  if (!row) return res.status(404).json({ error: 'Space not found.' });
  res.json({ id: row.id, name: row.name, createdAt: row.created_at, canvasState: row.canvas_state ? JSON.parse(row.canvas_state) : null });
});

app.put('/api/spaces/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  if (body.name != null) {
    const name = body.name.trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    await run('UPDATE spaces SET name = ? WHERE id = ?', [name, id]);
  }
  if ('canvasState' in body) {
    await run('UPDATE spaces SET canvas_state = ? WHERE id = ?', [
      body.canvasState ? JSON.stringify(body.canvasState) : null,
      id,
    ]);
  }
  res.json({ ok: true });
});

app.delete('/api/spaces/:id', async (req, res) => {
  const id = Number(req.params.id);
  await run('DELETE FROM spaces WHERE id = ?', [id]);
  // Tracked creators/categories aren't a foreign key away from spaces (no
  // cascade), so a deleted space's rows would otherwise sit around forever.
  await run('DELETE FROM bookmark_categories WHERE space_id = ?', [id]);
  await run('DELETE FROM bookmarks WHERE space_id = ?', [id]);
  await run('DELETE FROM creator_categories WHERE space_id = ?', [id]);
  res.json({ ok: true });
});

// The one path tracked creators/categories are allowed to move between
// spaces on — mirrors "Duplicate" copying canvas_state, so a duplicated
// space starts with the same tracked creators as its source instead of
// empty (every *other* new space starts empty; see space_id-scoping above).
async function duplicateSpaceTracking(fromSpaceId, toSpaceId) {
  const cats = await queryAll('SELECT id, name FROM creator_categories WHERE space_id = ? ORDER BY id', [fromSpaceId]);
  const idMap = new Map(); // source category id -> its copy's new id
  for (const c of cats) {
    const row = await queryOne('INSERT INTO creator_categories (name, space_id) VALUES (?, ?) RETURNING id', [c.name, toSpaceId]);
    idMap.set(c.id, row.id);
  }
  const bookmarks = await queryAll('SELECT handle, added_at FROM bookmarks WHERE space_id = ?', [fromSpaceId]);
  for (const b of bookmarks) {
    await run('INSERT INTO bookmarks (handle, added_at, space_id) VALUES (?, ?, ?) ON CONFLICT(space_id, handle) DO NOTHING', [b.handle, b.added_at, toSpaceId]);
  }
  const memberships = await queryAll('SELECT handle, category_id FROM bookmark_categories WHERE space_id = ?', [fromSpaceId]);
  for (const m of memberships) {
    const newCatId = idMap.get(m.category_id);
    if (newCatId == null) continue;
    await run('INSERT INTO bookmark_categories (handle, category_id, space_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [m.handle, newCatId, toSpaceId]);
  }
  await Promise.all(bookmarks.map((b) => syncPrimaryCategoryColumn(b.handle, toSpaceId)));
}

app.post('/api/spaces/:id/duplicate-tracking', async (req, res) => {
  const toSpaceId = Number(req.body && req.body.intoSpaceId);
  if (!toSpaceId) return res.status(400).json({ error: 'intoSpaceId is required.' });
  await duplicateSpaceTracking(Number(req.params.id), toSpaceId);
  res.json({ ok: true });
});

app.get('/api/settings/llm', async (req, res) => {
  const s = await getLlmSettings();
  res.json({ baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKey });
});

app.post('/api/settings/llm', async (req, res) => {
  const { baseUrl, apiKey, model } = req.body || {};
  if (baseUrl != null) {
    await run(
      "INSERT INTO settings (key, value) VALUES ('llmBaseUrl', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [baseUrl.trim() || LLM_DEFAULT_BASE_URL]
    );
  }
  if (apiKey) {
    await run(
      "INSERT INTO settings (key, value) VALUES ('llmApiKey', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [apiKey.trim()]
    );
  }
  if (model != null) {
    await run(
      "INSERT INTO settings (key, value) VALUES ('llmModel', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [model.trim() || LLM_DEFAULT_MODEL]
    );
  }
  const s = await getLlmSettings();
  res.json({ baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKey });
});

app.delete('/api/settings/llm', async (req, res) => {
  await run("DELETE FROM settings WHERE key = 'llmApiKey'");
  const s = await getLlmSettings();
  res.json({ baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKey });
});

// Shared by the global Script Genie (v0, pulls from the scripts table) and
// the v1 canvas AI Assistant (a real multi-turn chat now, not a one-shot
// generate) — same LLM call either way, just a growing message list
// instead of always exactly one. `items` (connected video/script
// transcripts) only ever gets folded into the *first* message — by the
// time there's a second turn, that context is already part of the
// conversation history the model is holding, so re-injecting it on every
// follow-up would just duplicate it.
async function callLlmForScript(items, messages) {
  const settings = await getLlmSettings();
  if (!settings.apiKey) throw new Error('Add an LLM API key in Settings first.');
  if (!items.length && !messages.some((m) => m.content?.trim())) throw new Error('Nothing to generate from yet.');
  const scriptsBlock = items
    .map((s, i) => `--- Script ${i + 1} (@${s.handle || 'unknown'}) ---\n${s.content}`)
    .join('\n\n');
  const chatMessages = messages.map((m, i) => (
    i === 0 && scriptsBlock
      ? { role: m.role, content: m.content ? `${scriptsBlock}\n\n--- Instructions ---\n${m.content}` : scriptsBlock }
      : m
  ));
  const resp = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: 'system', content: SCRIPT_SYSTEM_PROMPT }, ...chatMessages],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `LLM request failed (${resp.status})`);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('LLM returned no content.');
  return text;
}

app.post('/api/generate-script', async (req, res) => {
  const items = req.body && Array.isArray(req.body.items) ? req.body.items : await listScripts();
  // `messages` is the new multi-turn shape from v1's chat redesign;
  // anything still sending the old one-shot `{prompt}` (the base app's
  // Script Genie) gets wrapped into an equivalent single-message list so
  // callLlmForScript only ever has one shape to deal with.
  const messages = req.body && Array.isArray(req.body.messages) && req.body.messages.length
    ? req.body.messages
    : [{ role: 'user', content: (req.body && req.body.prompt) || '' }];
  try {
    const script = await callLlmForScript(items, messages);
    res.json({ script });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not reach the LLM provider.' });
  }
});

const ALLOWED_IMAGE_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

app.get('/api/image-proxy', async (req, res) => {
  let parsed;
  try {
    parsed = new URL(req.query.url);
  } catch {
    return res.status(400).end();
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.test(parsed.hostname)) {
    return res.status(400).end();
  }
  try {
    const upstream = await fetch(parsed.href, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!upstream.ok) return res.status(502).end();
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// One-time-per-boot migration: outlierScore's formula changed from
// "views ÷ median" to the IQR-rule version above. Recomputes it for every
// already-cached creator so scores don't sit inconsistent between old and
// freshly-scraped data for up to a week (the normal refresh cadence) — pure
// local recomputation from already-cached views, no Apify calls. Cheap
// enough to just always run rather than track whether it's needed.
async function migrateOutlierScores() {
  const rows = await queryAll('SELECT handle, data FROM reels');
  for (const row of rows) {
    await upsertReels(row.handle, computeOutlierScores(JSON.parse(row.data)));
  }
}
await migrateOutlierScores();

// One-time: every reel cached before the videoPlayCount fix above has a
// views count several times lower than what Instagram actually shows
// (confirmed directly against a live reel: cached 70K vs. Instagram's own
// 242K, matching videoPlayCount exactly) — and since the weekly refresh
// cooldown blocks re-scraping a creator that's already been "checked"
// recently, that stale number would otherwise just sit there for up to
// another 7 days rather than fixing itself. Clearing creator_checks once
// forces every tracked creator's next /api/creator call past that
// cooldown so they get re-scraped with the corrected field. Guarded by a
// settings flag (unlike migrateOutlierScores above) since, unlike that
// pure local recompute, this trades away everyone's remaining cooldown —
// fine once, not on every boot.
async function migrateStaleViewCounts() {
  if (await queryOne("SELECT value FROM settings WHERE key = 'viewsMigrationV1'")) return;
  await run('DELETE FROM creator_checks');
  await run("INSERT INTO settings (key, value) VALUES ('viewsMigrationV1', '1')");
}
await migrateStaleViewCounts();

// Same shape as the migration above, one more time: `videoPlayCount ??
// videoViewCount` could get stuck on the smaller videoViewCount forever
// once a scrape happened to catch videoPlayCount missing (confirmed live —
// the same reel had it present on one run and absent on the next), since
// `??` never revisits a value it already picked. pickViews' max-of-both
// fixes this going forward, but anything cached under the old logic needs
// one more forced re-scrape to actually pick up the corrected number.
async function migrateViewsMaxFix() {
  if (await queryOne("SELECT value FROM settings WHERE key = 'viewsMigrationV2'")) return;
  await run('DELETE FROM creator_checks');
  await run("INSERT INTO settings (key, value) VALUES ('viewsMigrationV2', '1')");
}
await migrateViewsMaxFix();

// One-time: before space-scoped tracking existed, every v1 space shared one
// global tracked-creator pool — which is exactly the bug being fixed (a
// brand new space showed every creator ever tracked anywhere). Rather than
// silently emptying out spaces that already exist, each gets its own copy
// of today's global (space_id=0) list once, here. Anything from this point
// on — new spaces, and any bookmark/category change in an existing one —
// is properly isolated per space (see the space_id columns above), so this
// never needs to run again.
async function migrateSpaceScopedTrackingSeed() {
  if (await queryOne("SELECT value FROM settings WHERE key = 'spaceScopedTrackingSeedV1'")) return;
  const spaces = await queryAll('SELECT id FROM spaces');
  for (const s of spaces) await duplicateSpaceTracking(0, s.id);
  await run("INSERT INTO settings (key, value) VALUES ('spaceScopedTrackingSeedV1', '1')");
}
await migrateSpaceScopedTrackingSeed();

// Not gated by a settings flag like the migrations above: the WHERE clause
// itself is the guard (only ever touches rows still missing an embedding),
// so it's already a no-op once caught up — cheap enough to just run on
// every boot. Also the only way pre-existing scripts get embedded at all
// if OPENAI_API_KEY is added after they were saved.
async function backfillScriptEmbeddings() {
  if (!process.env.OPENAI_API_KEY) return;
  const rows = await queryAll('SELECT id, content FROM scripts WHERE embedding IS NULL');
  for (const row of rows) {
    const vec = await embedText(row.content);
    if (vec) await run('UPDATE scripts SET embedding = ? WHERE id = ?', [vecLiteral(vec), row.id]);
  }
}
await backfillScriptEmbeddings();

app.listen(PORT, () => {
  console.log(`Kompass running at http://localhost:${PORT}`);
});
