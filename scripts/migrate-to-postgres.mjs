// One-off: copies existing data from the old libSQL/SQLite database into the
// new Postgres database. Run this AFTER starting the server at least once
// against DATABASE_URL (that's what creates the tables) and BEFORE anyone
// starts using the app on Postgres for real.
//
// Usage (local SQLite file -> Postgres):
//   DATABASE_URL=<neon-url> node scripts/migrate-to-postgres.mjs
//
// Usage (production Turso -> Postgres): grab TURSO_DATABASE_URL/
// TURSO_AUTH_TOKEN from Render's dashboard first, then:
//   DATABASE_URL=<neon-url> SOURCE_URL=<turso-url> SOURCE_TOKEN=<turso-token> \
//     node scripts/migrate-to-postgres.mjs
//
// ponytail: single-shot script, no dry-run/rollback — it's additive
// (INSERT ... ON CONFLICT DO NOTHING) so re-running it is safe, but it
// won't undo a partial run. Back up the Postgres DB first if that matters.
import 'dotenv/config';
import { createClient } from '@libsql/client';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the target Postgres connection string.');
  process.exit(1);
}

const sourceUrl = process.env.SOURCE_URL || `file:${path.join(__dirname, '..', 'data', 'store.db')}`;
const source = createClient({ url: sourceUrl, authToken: process.env.SOURCE_TOKEN });
const { Pool } = pg;
const target = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
});

async function copyPlain(table, columns) {
  const { rows } = await source.execute(`SELECT ${columns.join(',')} FROM ${table}`);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
  for (const row of rows) {
    await target.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      columns.map((c) => row[c])
    );
  }
  console.log(`${table}: ${rows.length} rows`);
}

// Same as copyPlain, but for tables with a SERIAL id — preserves the
// original id (so foreign keys elsewhere, e.g. video_tags.category_id,
// still resolve) and bumps the sequence afterward so future inserts don't
// collide with the copied ids.
async function copyWithId(table, columns) {
  await copyPlain(table, columns);
  await target.query(
    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
  );
}

async function main() {
  await copyPlain('creators', ['handle', 'profile']);
  await copyPlain('reels', ['handle', 'data']);
  await copyPlain('bookmarks', ['handle', 'added_at', 'category_id']);
  await copyPlain('bookmark_categories', ['handle', 'category_id']);
  await copyPlain('transcripts', ['shortcode', 'data']);
  await copyPlain('settings', ['key', 'value']);
  await copyWithId('creator_categories', ['id', 'name']);
  await copyWithId('video_categories', ['id', 'name']);
  await copyPlain('video_tags', ['shortcode', 'category_id']);
  await copyPlain('saved_videos', ['shortcode', 'saved_at']);
  await copyWithId('scripts', ['id', 'shortcode', 'handle', 'content', 'created_at']);
  await copyPlain('creator_checks', ['handle', 'checked_at']);
  await copyWithId('spaces', ['id', 'name', 'canvas_state', 'created_at']);
  console.log('Done.');
  await target.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
