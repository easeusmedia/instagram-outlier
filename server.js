import 'dotenv/config';
import express from 'express';
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tunables ---------------------------------------------------------
const REELS_LIMIT = 15; // initial load, and the "Load More" batch size
const REEL_ACTOR = 'apify~instagram-reel-scraper';
const PROFILE_ACTOR = 'apify~instagram-profile-scraper';
const TRANSCRIPT_ACTOR = 'apple_yang~instagram-transcripts-scraper';
const APIFY_TOKEN_ENV = process.env.APIFY_TOKEN || '';
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'store.db');
// ------------------------------------------------------------------------

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const SQL = await initSqlJs();
const db = fs.existsSync(DB_PATH)
  ? new SQL.Database(fs.readFileSync(DB_PATH))
  : new SQL.Database();

db.run(`CREATE TABLE IF NOT EXISTS creators (handle TEXT PRIMARY KEY, profile JSON)`);
db.run(`CREATE TABLE IF NOT EXISTS reels (handle TEXT PRIMARY KEY, data JSON)`);
db.run(`CREATE TABLE IF NOT EXISTS bookmarks (handle TEXT PRIMARY KEY, added_at TEXT)`);
db.run(`CREATE TABLE IF NOT EXISTS transcripts (shortcode TEXT PRIMARY KEY, data JSON)`);
db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
db.run(`CREATE TABLE IF NOT EXISTS creator_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
db.run(`CREATE TABLE IF NOT EXISTS video_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
db.run(`CREATE TABLE IF NOT EXISTS video_tags (shortcode TEXT PRIMARY KEY, category_id INTEGER)`);
db.run(`CREATE TABLE IF NOT EXISTS saved_videos (shortcode TEXT PRIMARY KEY, saved_at TEXT)`);
try {
  db.run('ALTER TABLE bookmarks ADD COLUMN category_id INTEGER');
} catch {
  // column already exists from a previous run
}

function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function getApifyToken() {
  const row = queryOne("SELECT value FROM settings WHERE key = 'apifyApiKey'", []);
  return (row && row.value) || APIFY_TOKEN_ENV;
}

if (!getApifyToken()) {
  console.error('Missing Apify token. Copy .env.example to .env and paste your Apify token.');
  process.exit(1);
}

function queryOne(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

const getCreatorProfile = (handle) => {
  const row = queryOne('SELECT profile FROM creators WHERE handle = ?', [handle]);
  return row ? JSON.parse(row.profile) : null;
};

const getCreatorReels = (handle) => {
  const row = queryOne('SELECT data FROM reels WHERE handle = ?', [handle]);
  return row ? JSON.parse(row.data) : null;
};

function upsertCreator(handle, profile) {
  db.run(
    'INSERT INTO creators (handle, profile) VALUES (?, ?) ON CONFLICT(handle) DO UPDATE SET profile = excluded.profile',
    [handle, JSON.stringify(profile)]
  );
  saveDb();
}

function upsertReels(handle, reels) {
  db.run(
    'INSERT INTO reels (handle, data) VALUES (?, ?) ON CONFLICT(handle) DO UPDATE SET data = excluded.data',
    [handle, JSON.stringify(reels)]
  );
  saveDb();
}

const isBookmarked = (handle) => !!queryOne('SELECT 1 FROM bookmarks WHERE handle = ?', [handle]);

function listBookmarks() {
  return queryAll('SELECT handle, added_at, category_id FROM bookmarks ORDER BY added_at').map((row) => ({
    handle: row.handle,
    addedAt: row.added_at,
    categoryId: row.category_id,
    profile: getCreatorProfile(row.handle),
  }));
}

function setBookmarkCategory(handle, categoryId) {
  db.run('UPDATE bookmarks SET category_id = ? WHERE handle = ?', [categoryId, handle]);
  saveDb();
}

// --- creator categories ----------------------------------------------------

function listCategories(table) {
  return queryAll(`SELECT id, name FROM ${table} ORDER BY id`);
}

function createCategory(table, name) {
  db.run(`INSERT INTO ${table} (name) VALUES (?)`, [name]);
  saveDb();
  return listCategories(table);
}

function renameCategory(table, id, name) {
  db.run(`UPDATE ${table} SET name = ? WHERE id = ?`, [name, id]);
  saveDb();
  return listCategories(table);
}

function deleteCreatorCategory(id) {
  db.run('UPDATE bookmarks SET category_id = NULL WHERE category_id = ?', [id]);
  db.run('DELETE FROM creator_categories WHERE id = ?', [id]);
  saveDb();
}

// --- video categories + per-video bookmarks (independent of creator categories) --

function deleteVideoCategory(id) {
  db.run('DELETE FROM video_tags WHERE category_id = ?', [id]);
  db.run('DELETE FROM video_categories WHERE id = ?', [id]);
  saveDb();
}

function getVideoTags() {
  return queryAll('SELECT shortcode, category_id FROM video_tags').reduce((acc, row) => {
    acc[row.shortcode] = row.category_id;
    return acc;
  }, {});
}

function setVideoTag(shortcode, categoryId) {
  if (categoryId == null) {
    db.run('DELETE FROM video_tags WHERE shortcode = ?', [shortcode]);
  } else {
    db.run(
      'INSERT INTO video_tags (shortcode, category_id) VALUES (?, ?) ON CONFLICT(shortcode) DO UPDATE SET category_id = excluded.category_id',
      [shortcode, categoryId]
    );
  }
  saveDb();
}

function getSavedVideos() {
  return queryAll('SELECT shortcode FROM saved_videos').map((row) => row.shortcode);
}

function setVideoSaved(shortcode, saved) {
  if (saved) {
    db.run(
      'INSERT INTO saved_videos (shortcode, saved_at) VALUES (?, ?) ON CONFLICT(shortcode) DO NOTHING',
      [shortcode, new Date().toISOString()]
    );
  } else {
    db.run('DELETE FROM saved_videos WHERE shortcode = ?', [shortcode]);
    db.run('DELETE FROM video_tags WHERE shortcode = ?', [shortcode]);
  }
  saveDb();
}


function addBookmark(handle) {
  db.run(
    'INSERT INTO bookmarks (handle, added_at) VALUES (?, ?) ON CONFLICT(handle) DO NOTHING',
    [handle, new Date().toISOString()]
  );
  saveDb();
}

function removeBookmark(handle) {
  db.run('DELETE FROM bookmarks WHERE handle = ?', [handle]);
  saveDb();
}

const getCachedTranscript = (shortcode) => {
  const row = queryOne('SELECT data FROM transcripts WHERE shortcode = ?', [shortcode]);
  return row ? JSON.parse(row.data) : null;
};

function upsertTranscript(shortcode, data) {
  db.run(
    'INSERT INTO transcripts (shortcode, data) VALUES (?, ?) ON CONFLICT(shortcode) DO UPDATE SET data = excluded.data',
    [shortcode, JSON.stringify(data)]
  );
  saveDb();
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
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${getApifyToken()}&maxItems=${maxItems}`;
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

function normalizeReelItem(it) {
  const shortCode = it.shortCode || it.shortcode || '';
  return {
    shortCode,
    url: it.url || (shortCode ? `https://www.instagram.com/reel/${shortCode}/` : ''),
    caption: it.caption || '',
    thumbnail: it.displayUrl || it.thumbnailUrl || '',
    videoUrl: it.videoUrl || null,
    views: numOrNull(it.videoViewCount ?? it.videoPlayCount),
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
    outlierScore: med > 0 && r.views != null ? r.views / med : null,
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

// --- app --------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

    let profile = forceRefresh ? null : getCreatorProfile(handle);
    let reels = forceRefresh ? null : getCreatorReels(handle);

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

      upsertCreator(handle, profile);
      upsertReels(handle, reels);
    } else if (reels.length < requestedLimit) {
      // "Load More": cache doesn't have enough yet, re-scrape at the bigger size.
      const reelItems = await callApify(
        REEL_ACTOR,
        { username: [handle], resultsLimit: requestedLimit },
        requestedLimit
      );
      reels = mergeReels(reels, reelItems || []);
      upsertReels(handle, reels);
    }
    // else: cache already covers what was asked for — serve it as-is, no
    // Apify call. Append &refresh=1 to force a fresh scrape for new uploads.

    res.json({ profile, reels, bookmarked: isBookmarked(handle), hasMore: reels.length >= requestedLimit });
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

    const cached = req.query.refresh === '1' ? null : getCachedTranscript(parsed.code);
    if (cached) return res.json({ transcript: cached, cached: true });

    const postUrl = `https://www.instagram.com/${parsed.kind}/${parsed.code}/`;
    const items = await callApify(TRANSCRIPT_ACTOR, { videoUrl: postUrl }, 10);
    const item = items && items[0];
    const transcript = item && item.text;
    if (!transcript) throw new Error((item && item.errMsg) || 'Instagram did not return a transcript for this reel.');

    upsertTranscript(parsed.code, transcript);
    res.json({ transcript, cached: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

app.get('/api/bookmarks', (req, res) => {
  res.json({ bookmarks: listBookmarks() });
});

app.post('/api/bookmarks', (req, res) => {
  const { handle, action } = req.body || {};
  if (!handle || !['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'handle and action ("add" or "remove") are required.' });
  }
  const h = handle.toLowerCase();
  if (action === 'add') {
    if (!getCreatorProfile(h)) {
      return res.status(400).json({ error: 'Load this creator on the Add tab first, then bookmark it.' });
    }
    addBookmark(h);
  } else {
    removeBookmark(h);
  }
  res.json({ bookmarks: listBookmarks() });
});

app.post('/api/bookmarks/category', (req, res) => {
  const { handle, categoryId } = req.body || {};
  if (!handle) return res.status(400).json({ error: 'handle is required.' });
  setBookmarkCategory(handle.toLowerCase(), categoryId ?? null);
  res.json({ bookmarks: listBookmarks() });
});

function maskApifyKey(token) {
  return token.length <= 8 ? '••••' : `${token.slice(0, 10)}…${token.slice(-4)}`;
}

function apifyKeyStatus() {
  const token = getApifyToken();
  const usingOverride = !!queryOne("SELECT value FROM settings WHERE key = 'apifyApiKey'", []);
  return { masked: token ? maskApifyKey(token) : null, usingOverride };
}

async function testApifyKey(token) {
  const res = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`);
  if (!res.ok) return { valid: false };
  const data = await res.json();
  return { valid: true, username: data?.data?.username || null };
}

app.get('/api/settings/apify-key', (req, res) => {
  res.json(apifyKeyStatus());
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

app.post('/api/settings/apify-key', (req, res) => {
  const apiKey = req.body?.apiKey?.trim();
  if (!apiKey) return res.status(400).json({ error: 'API key is required.' });
  db.run(
    "INSERT INTO settings (key, value) VALUES ('apifyApiKey', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [apiKey]
  );
  saveDb();
  res.json(apifyKeyStatus());
});

app.delete('/api/settings/apify-key', (req, res) => {
  db.run("DELETE FROM settings WHERE key = 'apifyApiKey'");
  saveDb();
  res.json(apifyKeyStatus());
});

app.get('/api/creator-categories', (req, res) => {
  res.json({ categories: listCategories('creator_categories') });
});

app.post('/api/creator-categories', (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  res.json({ categories: createCategory('creator_categories', name) });
});

app.patch('/api/creator-categories/:id', (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  res.json({ categories: renameCategory('creator_categories', Number(req.params.id), name) });
});

app.delete('/api/creator-categories/:id', (req, res) => {
  deleteCreatorCategory(Number(req.params.id));
  res.json({ categories: listCategories('creator_categories'), bookmarks: listBookmarks() });
});

app.get('/api/video-categories', (req, res) => {
  res.json({ categories: listCategories('video_categories') });
});

app.post('/api/video-categories', (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  res.json({ categories: createCategory('video_categories', name) });
});

app.patch('/api/video-categories/:id', (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  res.json({ categories: renameCategory('video_categories', Number(req.params.id), name) });
});

app.delete('/api/video-categories/:id', (req, res) => {
  deleteVideoCategory(Number(req.params.id));
  res.json({ categories: listCategories('video_categories'), videoTags: getVideoTags() });
});

app.get('/api/video-tags', (req, res) => {
  res.json({ videoTags: getVideoTags() });
});

app.post('/api/video-tags', (req, res) => {
  const { shortCode, categoryId } = req.body || {};
  if (!shortCode) return res.status(400).json({ error: 'shortCode is required.' });
  setVideoTag(shortCode, categoryId ?? null);
  // Filing a video into a category is itself an act of saving it.
  if (categoryId != null) setVideoSaved(shortCode, true);
  res.json({ videoTags: getVideoTags(), shortCodes: getSavedVideos() });
});

app.get('/api/saved-videos', (req, res) => {
  res.json({ shortCodes: getSavedVideos() });
});

app.post('/api/saved-videos', (req, res) => {
  const { shortCode, saved } = req.body || {};
  if (!shortCode) return res.status(400).json({ error: 'shortCode is required.' });
  setVideoSaved(shortCode, saved !== false);
  res.json({ shortCodes: getSavedVideos(), videoTags: getVideoTags() });
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
