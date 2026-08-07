# Kompass

Local-first tool for studying viral reels from specific Instagram creators you choose. Add an account by username or link, see its reels scored by outlier (views ÷ that creator's median views), bookmark accounts, and browse a combined feed with filters/sort.

## Setup

```bash
npm install
cp .env.example .env
```

Paste your Apify token into `.env` as `APIFY_TOKEN`. Requires Node.js 18+ (for built-in `fetch`).

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## How it works

- **Research tab**: type a username, `@handle`, `instagram.com/username`, or a `/reel/`, `/p/`, `/tv/` link. The server normalizes it to a username, scrapes reels via Apify, computes each reel's outlier score, and shows an account header + reel list. Bookmark the creator to save it — this is for discovery, not the main workspace.
- **Playground tab**: your central workspace. It always aggregates reels from every bookmarked creator into one feed — searching on Research never changes what Playground shows. Use the **Creators** checklist in the Filters drawer to narrow the feed down to specific creators; it's a pure visibility filter, not a scope switch.
- Reopening a bookmarked/previously-loaded account reads straight from the local SQLite DB with **no Apify call at all** — instant, no credit spent. Append `&refresh=1` to `/api/creator` requests (or use `?refresh=1` manually) to force a fresh scrape and pick up new uploads.
- Every reel card has a **Get Transcript** button that fetches the transcript for just that one reel, on demand, so you only pay for the ones you actually care about. Fetched transcripts are cached by shortcode in SQLite, so re-fetching the same reel is free.
- **Play** uses a native `<video>` element sourced from the scraper's direct video URL — no Instagram embed chrome. If that URL is missing or expired, it falls back to the `instagram.com/.../embed` iframe.
- **Filters panel**: click **Filters** (top right) to slide in a drawer with an **Outlier Score range** slider (only shows reels scoring within the chosen min–max), plus sort/length/upload-date controls. Each tab's slider filters that tab's own feed independently. Click the button again or click outside the drawer to close it. The header stays pinned to the top while scrolling so Filters/Research/Playground are always reachable.
- Badge colors (orange "hot" ≥10×, blue "warm" ≥3×) are fixed, not configurable — they're just a quick visual signal, unrelated to the Outlier Score filter.
- **Apify API key** (gear icon, top right): add, replace, test, or remove the Apify token used for all scraping without touching `.env` or restarting — useful when a key hits its usage limit. Falls back to `.env`'s `APIFY_TOKEN` when no override is saved.
- **Creator categories**: group bookmarked creators (e.g. "Science & Tech") by dragging their chips between category sections in the sidebar. Add a category with the input above it, rename one with its pencil icon. An "Uncategorized" bucket only appears when something actually needs it.
- **Save a video** with the **⋮** button on any reel card (Research or Playground). It opens a small menu: a "Save" toggle plus its own **video category** list — completely separate from creator categories, with its own names and its own management (rename/delete live in the Playground Filters drawer under "Video Categories"; you can also add a new one right from the card's menu). Filing a video into a category saves it automatically if it wasn't already; unsaving a video clears its category but never touches the creator's bookmark. A colored dot on the thumbnail shows which category a video is in. There's no "Uncategorized" bucket — untagged reels just aren't filtered by category. In the Filters drawer, check **★ Saved only** to see just the videos you've saved, and use the Video Categories checklist to narrow further.
- **Layout**: the feed fills the wide left/main area; bookmarked creators live in a sidebar on the right; filters live in a drawer that slides in from the right on demand instead of permanently eating into feed width.
- **Load More**: Research fetches reels from Apify in batches of 15 via **Load More**. Playground already has all of its (cached) reels in memory, so **Load More** there just reveals 15 more of the already-filtered/sorted list at a time — no extra network call.
- **Script Generator** (sidebar, below Bookmarked Creators — visible on both Research and Playground): drag any reel card onto the drop zone to grab its transcript (fetching it first via Apify if it isn't cached yet, and reusing the same cache the per-card **Get Transcript** button uses — no duplicate Apify calls) and drop it in as a note, shown as a small thumbnail labeled "Script 1", "Script 2", etc. Click one to read or edit it full-screen. Once you've dragged in at least one, **✨ Script Genie** opens a window showing everything you've loaded plus a prompt box — write what you want (e.g. "write a new script inspired by these, about X"), hit **Generate Script** inside that window, and it sends your prompt plus every loaded script to an LLM with a "world's best viral scriptwriter" system prompt. The result can be copied or saved as a new script note. Configure the LLM in Settings (gear icon) — any OpenAI-compatible provider works via a Base URL + Model + API key; defaults to [Groq's free tier](https://console.groq.com/keys) (fast, open-source models, no cost).

## Storage

Everything is stored in Postgres via [`pg`](https://node-postgres.com/) — same database for local dev and production, pointed at by one `DATABASE_URL` env var. [Neon](https://neon.tech) has a free tier with no inactivity expiry and first-class [pgvector](https://neon.tech/docs/extensions/pgvector) support (used for semantic script search below) — create a project there, copy its connection string, and paste it into `.env` (or your host's environment variable settings) as `DATABASE_URL`.

The `vector` extension is created automatically on boot (`CREATE EXTENSION IF NOT EXISTS vector`).

> Migrating off the old Turso/SQLite setup? `scripts/migrate-to-postgres.mjs` copies every table across once `DATABASE_URL` is set and the server's been started at least once (to create the tables).

## Accounts & login

Sign-in is always on: email/password accounts (`/auth/signup`, `/auth/login`) are the primary system, stored in the `users` table with scrypt-hashed passwords (Node's built-in `crypto`, no extra dependency). Signup rejects disposable/temporary-mail domains via the [`disposable-email-domains`](https://github.com/disposable-email-domains/disposable-email-domains) list.

Optional extras, set as env vars on your host:

```bash
ADMIN_EMAIL=            # seeds one admin account on boot (no-op once it exists)
ADMIN_PASSWORD=

OPENAI_API_KEY=         # enables semantic script search (pgvector) — see below

# Also allow "Sign in with Google" alongside email/password:
GOOGLE_CLIENT_ID=      # from a Google Cloud OAuth client (Web application type)
GOOGLE_CLIENT_SECRET=
ALLOWED_EMAILS=you@gmail.com,teammate@gmail.com   # comma-separated allowlist; leave blank to allow any Google account
SESSION_SECRET=        # any random string; keeps everyone logged in across restarts
```

In the Google Cloud Console, add `https://your-app-url/auth/google/callback` as an authorized redirect URI on the OAuth client. Every user shares the same bookmarks/scripts/spaces data today — accounts gate *access*, not per-user data (that's a bigger change, not built yet).

## Semantic script search (pgvector)

Set `OPENAI_API_KEY` and every saved script gets embedded (`text-embedding-3-small`) in the background as it's created or edited. `GET /api/search?q=...` then does a cosine-similarity search over `scripts.embedding` and returns the closest matches. Without the key, scripts just never get embedded and `/api/search` returns a clear "not configured" error instead of failing oddly.

## Cost controls

- `REELS_LIMIT` at the top of [server.js](server.js) is both the initial batch size and the "Load More" increment (default 15).
- Apify's free tier gives **$5/month** of platform credit.
- Per-account scraping (`apify/instagram-reel-scraper` + `apify/instagram-profile-scraper`) is metadata-only and cheap — no batch transcript option, since that would fetch transcripts for reels you never look at.
- The per-reel **Get Transcript** button uses `apple_yang/instagram-transcripts-scraper`, a cheap dedicated transcript actor (~$0.001–0.0045/minute), so transcribing only the reels you care about is nearly free.

## Notes

- Instagram thumbnail and profile-picture URLs are hotlink-protected in the browser, so the frontend routes them through `GET /api/image-proxy` (server-side fetch, allowlisted to `cdninstagram.com`/`fbcdn.net` hosts to prevent it being used as an open proxy). Falls back to a placeholder icon if the fetch still fails.
- Reel embeds (`instagram.com/reel/{code}/embed`) are only used as a fallback and are lazy-loaded — never mounted until needed, so the page never opens a dozen iframes at once.
