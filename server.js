import 'dotenv/config';
import express from 'express';
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tunables ---------------------------------------------------------
const REELS_LIMIT = 15; // initial load, and the "Load More" batch size
const REEL_ACTOR = 'apify~instagram-reel-scraper';
const PROFILE_ACTOR = 'apify~instagram-profile-scraper';
const TRANSCRIPT_ACTOR = 'apple_yang~instagram-transcripts-scraper';
const APIFY_TOKEN_ENV = process.env.APIFY_TOKEN || '';
const PORT = process.env.PORT || 3000;
// How often a cache hit is allowed to trigger a background "is there
// anything new?" check, per creator. Bounds API cost from repeat searches
// while still catching new uploads without the user asking for &refresh=1.
const FRESHNESS_CHECK_COOLDOWN_MS = 30 * 60 * 1000;
// ------------------------------------------------------------------------

// --- Google OAuth login gate -------------------------------------------
// Only turns on when GOOGLE_CLIENT_ID/SECRET are set, so local dev stays
// zero-setup. This is a single-tenant gate (allow/deny), not a multi-user
// account system — the app has no per-user data model, so anything past
// "is this a known Google account" would be unused complexity.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
// ponytail: regenerated on every boot if unset, which logs everyone out on
// deploy/restart. Set SESSION_SECRET in the environment to persist sessions.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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

// Turso (libSQL) when TURSO_DATABASE_URL is set — this is what makes the app
// deployable on Render/Vercel, since neither gives you a persistent local
// disk to keep a SQLite file on. With no env var set, falls back to a local
// SQLite file for zero-setup local dev (same client, same SQL, just a
// different URL scheme).
const DB_PATH = path.join(__dirname, 'data', 'store.db');
if (!process.env.TURSO_DATABASE_URL) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${DB_PATH}`,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function run(sql, args = []) {
  return db.execute({ sql, args });
}

async function queryOne(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0] || null;
}

async function queryAll(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

await run(`CREATE TABLE IF NOT EXISTS creators (handle TEXT PRIMARY KEY, profile JSON)`);
await run(`CREATE TABLE IF NOT EXISTS reels (handle TEXT PRIMARY KEY, data JSON)`);
await run(`CREATE TABLE IF NOT EXISTS bookmarks (handle TEXT PRIMARY KEY, added_at TEXT, category_id INTEGER)`);
await run(`CREATE TABLE IF NOT EXISTS transcripts (shortcode TEXT PRIMARY KEY, data JSON)`);
await run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
await run(`CREATE TABLE IF NOT EXISTS creator_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
await run(`CREATE TABLE IF NOT EXISTS video_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
await run(`CREATE TABLE IF NOT EXISTS video_tags (shortcode TEXT PRIMARY KEY, category_id INTEGER)`);
await run(`CREATE TABLE IF NOT EXISTS saved_videos (shortcode TEXT PRIMARY KEY, saved_at TEXT)`);
await run(`CREATE TABLE IF NOT EXISTS scripts (id INTEGER PRIMARY KEY AUTOINCREMENT, shortcode TEXT, handle TEXT, content TEXT, created_at TEXT)`);
await run(`CREATE TABLE IF NOT EXISTS creator_checks (handle TEXT PRIMARY KEY, checked_at TEXT)`);
// v1 canvas: a "space" is one named Drawflow board. canvas_state is
// whatever editor.export() produced last, saved back verbatim.
await run(`CREATE TABLE IF NOT EXISTS spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, canvas_state JSON, created_at TEXT)`);

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

async function isBookmarked(handle) {
  return !!(await queryOne('SELECT 1 FROM bookmarks WHERE handle = ?', [handle]));
}

async function listBookmarks() {
  const rows = await queryAll('SELECT handle, added_at, category_id FROM bookmarks ORDER BY added_at');
  return Promise.all(
    rows.map(async (row) => ({
      handle: row.handle,
      addedAt: row.added_at,
      categoryId: row.category_id,
      profile: await getCreatorProfile(row.handle),
    }))
  );
}

async function setBookmarkCategory(handle, categoryId) {
  await run('UPDATE bookmarks SET category_id = ? WHERE handle = ?', [categoryId, handle]);
}

// --- creator categories ----------------------------------------------------

async function listCategories(table) {
  return queryAll(`SELECT id, name FROM ${table} ORDER BY id`);
}

async function createCategory(table, name) {
  await run(`INSERT INTO ${table} (name) VALUES (?)`, [name]);
  return listCategories(table);
}

async function renameCategory(table, id, name) {
  await run(`UPDATE ${table} SET name = ? WHERE id = ?`, [name, id]);
  return listCategories(table);
}

async function deleteCreatorCategory(id) {
  await run('UPDATE bookmarks SET category_id = NULL WHERE category_id = ?', [id]);
  await run('DELETE FROM creator_categories WHERE id = ?', [id]);
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

async function listScripts() {
  return queryAll('SELECT * FROM scripts ORDER BY created_at DESC');
}

async function addScript(shortcode, handle, content) {
  const existing = await queryOne('SELECT id FROM scripts WHERE shortcode = ?', [shortcode]);
  if (!existing) {
    await run(
      'INSERT INTO scripts (shortcode, handle, content, created_at) VALUES (?, ?, ?, ?)',
      [shortcode, handle, content, new Date().toISOString()]
    );
  }
  return listScripts();
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

async function addBookmark(handle) {
  await run(
    'INSERT INTO bookmarks (handle, added_at) VALUES (?, ?) ON CONFLICT(handle) DO NOTHING',
    [handle, new Date().toISOString()]
  );
}

async function removeBookmark(handle) {
  await run('DELETE FROM bookmarks WHERE handle = ?', [handle]);
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

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Instagram (via the scraper) reports two different metrics: videoViewCount
// and videoPlayCount ("plays", counts every replay/autoplay loop). Verified
// directly against Instagram's own grid (the small eye-icon count) for a
// real reel: it matched videoPlayCount, while videoViewCount read roughly
// half that — so videoPlayCount is the one that belongs in the "views"
// column. videoViewCount is kept only as a fallback for the rare case
// videoPlayCount is missing, so a reel isn't dropped from the outlier math
// entirely over one absent field.
const OUTLIER_SCORE_CAP = 100;

function normalizeReelItem(it) {
  const shortCode = it.shortCode || it.shortcode || '';
  return {
    shortCode,
    url: it.url || (shortCode ? `https://www.instagram.com/reel/${shortCode}/` : ''),
    caption: it.caption || '',
    thumbnail: it.displayUrl || it.thumbnailUrl || '',
    videoUrl: it.videoUrl || null,
    views: numOrNull(it.videoPlayCount ?? it.videoViewCount),
    likes: numOrNull(it.likesCount),
    duration: numOrNull(it.videoDuration),
    timestamp: it.timestamp || null,
    transcript: it.transcript || null,
  };
}

function computeOutlierScores(normalized) {
  const views = normalized.map((r) => r.views).filter((v) => v != null && v > 0);
  const med = median(views);
  return normalized.map((r) => ({
    ...r,
    outlierScore: med > 0 && r.views != null ? Math.min(r.views / med, OUTLIER_SCORE_CAP) : null,
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

// Fired (not awaited) after a cache-hit response has already gone out, so it
// never slows the request down. Does the cheapest possible Apify call — one
// reel — to see if the creator has posted anything since we last cached
// them; only pays for a full re-scrape when there's actually something new
// to merge in. Skipped entirely if we checked this creator recently, to
// bound API cost from repeat searches.
async function checkForNewReelsInBackground(handle, cachedReels, limit) {
  try {
    if (Date.now() - (await getLastCheckedAt(handle)) < FRESHNESS_CHECK_COOLDOWN_MS) return;
    await markChecked(handle);

    // maxItems must clear Apify's minimum-run-cost floor for this actor
    // (same reason resolveOwnerFromPost uses 5, not 1) — resultsLimit still
    // caps what's actually scraped to just the newest reel.
    const [latest] = (await callApify(REEL_ACTOR, { username: [handle], resultsLimit: 1 }, 5)) || [];
    if (!latest) return;

    const newest = cachedReels[0]; // reels are stored newest-first
    const latestTime = latest.timestamp ? new Date(latest.timestamp).getTime() : 0;
    const newestCachedTime = newest?.timestamp ? new Date(newest.timestamp).getTime() : 0;
    if (!latest.shortCode || latest.shortCode === newest?.shortCode || latestTime <= newestCachedTime) {
      return; // nothing new
    }

    const reelItems = await callApify(REEL_ACTOR, { username: [handle], resultsLimit: limit }, limit);
    await upsertReels(handle, mergeReels(cachedReels, reelItems || []));
  } catch (err) {
    console.error(`Background freshness check failed for ${handle}:`, err.message);
  }
}

// --- app --------------------------------------------------------------

const app = express();
app.use(express.json());

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
    res.setHeader('Set-Cookie', [
      'oauth_state=; Path=/; Max-Age=0',
      `session=${makeSessionCookie(email)}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}; SameSite=Lax`,
    ]);
    res.redirect('/');
  } catch (err) {
    res.status(500).send(`Login failed: ${err.message}`);
  }
});

app.get('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.redirect('/login.html');
});

app.get('/api/me', (req, res) => {
  const email = AUTH_ENABLED ? verifySessionCookie(parseCookies(req).session) : null;
  res.json({ authEnabled: AUTH_ENABLED, email });
});

if (AUTH_ENABLED) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path === '/login.html' || req.path === '/api/me') return next();
    const email = verifySessionCookie(parseCookies(req).session);
    if (email) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required.' });
    res.redirect('/login.html');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// v1: the new node-canvas UI, served as its own page so the base app at "/"
// is untouched. Same backend, same database, different frontend.
app.get('/v1', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'v1.html'));
});

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
    res.json({ profile, reels: withTranscripts, bookmarked: await isBookmarked(handle), hasMore: withTranscripts.length >= requestedLimit });

    if (!freshlyScraped && !forceRefresh) {
      checkForNewReelsInBackground(handle, reels, requestedLimit);
    }
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

app.get('/api/bookmarks', async (req, res) => {
  res.json({ bookmarks: await listBookmarks() });
});

app.post('/api/bookmarks', async (req, res) => {
  const { handle, action } = req.body || {};
  if (!handle || !['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'handle and action ("add" or "remove") are required.' });
  }
  const h = handle.toLowerCase();
  if (action === 'add') {
    if (!(await getCreatorProfile(h))) {
      return res.status(400).json({ error: 'Load this creator on the Add tab first, then bookmark it.' });
    }
    await addBookmark(h);
  } else {
    await removeBookmark(h);
  }
  res.json({ bookmarks: await listBookmarks() });
});

app.post('/api/bookmarks/category', async (req, res) => {
  const { handle, categoryId } = req.body || {};
  if (!handle) return res.status(400).json({ error: 'handle is required.' });
  await setBookmarkCategory(handle.toLowerCase(), categoryId ?? null);
  res.json({ bookmarks: await listBookmarks() });
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
  res.json({ categories: await listCategories('creator_categories') });
});

app.post('/api/creator-categories', async (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  res.json({ categories: await createCategory('creator_categories', name) });
});

app.patch('/api/creator-categories/:id', async (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  res.json({ categories: await renameCategory('creator_categories', Number(req.params.id), name) });
});

app.delete('/api/creator-categories/:id', async (req, res) => {
  await deleteCreatorCategory(Number(req.params.id));
  res.json({ categories: await listCategories('creator_categories'), bookmarks: await listBookmarks() });
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
  await run('UPDATE scripts SET content = ? WHERE id = ?', [content, Number(req.params.id)]);
  res.json({ scripts: await listScripts() });
});

app.delete('/api/scripts/:id', async (req, res) => {
  await run('DELETE FROM scripts WHERE id = ?', [Number(req.params.id)]);
  res.json({ scripts: await listScripts() });
});

// --- v1 canvas: spaces ---------------------------------------------------

app.get('/api/spaces', async (req, res) => {
  const rows = await queryAll('SELECT id, name, created_at FROM spaces ORDER BY id DESC');
  res.json({ spaces: rows });
});

app.post('/api/spaces', async (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const result = await run('INSERT INTO spaces (name, canvas_state, created_at) VALUES (?, ?, ?)', [
    name,
    null,
    new Date().toISOString(),
  ]);
  res.json({ id: Number(result.lastInsertRowid) });
});

app.get('/api/spaces/:id', async (req, res) => {
  const row = await queryOne('SELECT id, name, canvas_state, created_at FROM spaces WHERE id = ?', [
    Number(req.params.id),
  ]);
  if (!row) return res.status(404).json({ error: 'Space not found.' });
  res.json({ id: row.id, name: row.name, createdAt: row.created_at, canvasState: row.canvas_state ? JSON.parse(row.canvas_state) : null });
});

app.put('/api/spaces/:id', async (req, res) => {
  const canvasState = (req.body && req.body.canvasState) || null;
  await run('UPDATE spaces SET canvas_state = ? WHERE id = ?', [
    canvasState ? JSON.stringify(canvasState) : null,
    Number(req.params.id),
  ]);
  res.json({ ok: true });
});

app.delete('/api/spaces/:id', async (req, res) => {
  await run('DELETE FROM spaces WHERE id = ?', [Number(req.params.id)]);
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
// the v1 canvas (generates from whatever's connected to a chat node) — same
// LLM call, different source for which transcripts go in.
async function callLlmForScript(items, prompt) {
  const settings = await getLlmSettings();
  if (!settings.apiKey) throw new Error('Add an LLM API key in Settings first.');
  if (!items.length) throw new Error('Nothing to generate from yet.');
  const scriptsBlock = items
    .map((s, i) => `--- Script ${i + 1} (@${s.handle || 'unknown'}) ---\n${s.content}`)
    .join('\n\n');
  const userContent = prompt ? `${scriptsBlock}\n\n--- Instructions ---\n${prompt}` : scriptsBlock;
  const resp = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: SCRIPT_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `LLM request failed (${resp.status})`);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('LLM returned no content.');
  return text;
}

app.post('/api/generate-script', async (req, res) => {
  const prompt = (req.body && req.body.prompt) || '';
  const items = req.body && Array.isArray(req.body.items) ? req.body.items : await listScripts();
  try {
    const script = await callLlmForScript(items, prompt);
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

app.listen(PORT, () => {
  console.log(`Instagram Outlier running at http://localhost:${PORT}`);
});
