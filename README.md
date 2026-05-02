# Telegram Channel Sync + Post (Node.js)

Mirror posts from a source Telegram channel into local storage, then post from local state to a destination channel.

## Prerequisites

- Node.js 18+
- A Telegram API app (`api_id`, `api_hash`) from https://my.telegram.org
- Your account must have access to the source channel and permission to post in the destination channel

## Setup

```bash
npm install
cp .env.example .env
```

If you plan to use `local2x-web`, also install a browser once:

```bash
npx playwright install chromium
```

Edit `.env` with your values.
`SOURCE_CHANNEL` and `DEST_CHANNEL` accept:

- `@channel_handle`
- `https://t.me/channel_handle`
- private invite links like `https://t.me/+AbCdEf...`
- numeric peer IDs (if your account can resolve them)
- `LOCAL_ARCHIVE_DIR` controls where `archive.db` and post folders are stored (default `channel-archive`).
- Optional: `TEXT_RULES_FILE` points to a JSON rule file for text cleanup/rewrite (`remove-literal`, `replace-literal`, `remove-regex`, `replace-regex`).
- Optional: `POST_AUTOPREPEND_LINE1` and `POST_AUTOPREPEND_LINE2` prepend header lines during local publish (`local2dest`, `local2x`, `local2x-web`, `local2blogger`, `local2wp.com`, `local2bsky`).
- Optional: `POST_AUTOAPPEND_LINE1` and `POST_AUTOAPPEND_LINE2` append footer lines during local publish (`local2dest`, `local2x`, `local2x-web`, `local2blogger`, `local2wp.com`, `local2bsky`).
- `${ORIGINAL_POST_DATE}` is supported in both prepend/append lines and resolves to `YYYY-MM-DD`.

Example `TEXT_RULES_FILE` (`text-rules.json`):

```json
{
  "remove-literal": ["example text to remove"],
  "replace-literal": [{ "from": "@old", "to": "@new" }],
  "remove-regex": [{ "pattern": "foo\\s+bar", "flags": "gmi" }],
  "replace-regex": [{ "pattern": "old\\s+name", "replacement": "new name", "flags": "gi" }]
}
```

A starter file is included as `text-rules.example.json`.

## Run

```bash
npm run src2local
npm run local2dest
npm run local2x
npm run local2x-web
npm run local2blogger
npm run local2wp.com
npm run local2bsky
npm run local2insta
npm run local2web-static-js
npm run local2x-webext-serv
```

Optional per-run archive override:

```bash
npm run src2local -- --local myfolder/channel-archive1
npm run local2dest -- --local myfolder/channel-archive1
npm run local2x -- --local myfolder/channel-archive1
npm run local2x-web -- --local myfolder/channel-archive1
npm run local2blogger -- --local myfolder/channel-archive1
npm run local2wp.com -- --local myfolder/channel-archive1
npm run local2bsky -- --local myfolder/channel-archive1
npm run local2web-static-js -- --local myfolder/channel-archive1
npm run local2x-webext-serv -- --local myfolder/channel-archive1
```

Optional per-run environment file override:

```bash
npm run src2local -- --env .env.alt
npm run local2dest -- --env .env.alt --local myfolder/channel-archive1
npm run local2dest -- --env .env.alt --local myfolder/channel-archive1 --dest https://t.me/your_dest_channel
npm run local2dest -- --local myfolder/channel-archive1 --dests "https://t.me/chan1||https://t.me/chan2||https://t.me/chan3"
```

Notes:
- `--env` accepts `--env <file>` or `--env=<file>`.
- Empty `--env` value is rejected with a clear error.
- `--dest` accepts `--dest <channel>` or `--dest=<channel>` and overrides `.env` `DEST_CHANNEL` for that run.
- `--dests` accepts `--dests "a||b||c"` (local2dest only) and runs the same local2dest logic for each destination.
- `DEST_CHANNELS_ASYNC=1` uses concurrent child workers; cap concurrency with `DEST_CHANNELS_MAX_CONCURRENCY` (default `3`).

Note: `local2insta` command is currently registered but not implemented yet.

Legacy `npm run clone` is removed.

On first run (when `TG_SESSION` is empty), the script asks for phone/code (and 2FA if enabled), then prints a `TG_SESSION=...` value. Save that in `.env` for reusable non-interactive auth.

## Notes

- `src2local`:
  - Pre-scan source channel.
  - Clean text/links, archive files to `channel-archive/`, and upsert local SQLite state.
  - No destination posting.
  - `USE_CACHE_AS_SOURCE=1` forces cache-only source mode (no source-channel contact).
- `local2dest`:
  - Loads prepared post units from `archive.db` + `channel-archive` (no source-channel scan/cache dependency).
  - Uses DB state to skip already posted items.
  - Supports multi-destination runs via `--dests` or `DEST_CHANNELS` (separator `||`).
  - Multi-destination execution mode:
    - `DEST_CHANNELS_ASYNC=0` -> sequential (one-by-one)
    - `DEST_CHANNELS_ASYNC=1` -> parallel child processes (bounded by `DEST_CHANNELS_MAX_CONCURRENCY`)
  - Tries resolving `DEST_CHANNEL` first.
  - If resolved channel is writable, uses it directly.
  - If resolve fails, or resolve succeeds but channel is not writable by current account, and `DEST_AUTO_CREATE=1`, creates destination channel automatically and continues.
  - Public auto-create requires a destination channel handle (from `DEST_CHANNEL`, e.g. `@my_channel` or `https://t.me/my_channel`).
  - Optional auto-increment tries `base`, `base1`, `base2`, ... (`DEST_CREATE_CHANNEL_URI_AUTO_INCREMENT=1`).
  - Destination posting state is isolated per source->destination pair.

## local2dest Flow (Complete)

Given:
- command: `local2dest` (optionally with `--dest`)
- effective destination input = `--dest` override if provided, else `.env` `DEST_CHANNEL`
- multi-destination input precedence:
  - `--dests` > `--dest` > `DEST_CHANNELS` > `DEST_CHANNEL`

Decision flow:

1. Resolve destination entity from effective destination input.
1.1 Resolve fails:
- `DEST_AUTO_CREATE=0`: fail/exit (destination not resolvable).
- `DEST_AUTO_CREATE=1`: enter destination auto-create flow.

1.2 Resolve succeeds:
- Run destination write-access check for current Telegram account.
- Writable: use resolved channel and continue posting.
- Not writable:
  - `DEST_AUTO_CREATE=0`: fail/exit (resolved destination exists but is not writable by current account).
  - `DEST_AUTO_CREATE=1`: enter destination auto-create flow.

2. Destination auto-create flow (`DEST_AUTO_CREATE=1`)
2.1 Create new channel via Telegram API using:
- `DEST_CREATE_TITLE` / `DEST_CREATE_ABOUT` (or defaults)
- optional `DEST_CREATE_ICON` (best-effort; warning on failure, continue)
- optional `DEST_CREATE_DISABLE_REACTIONS=1` (best-effort; warning on failure, continue)

2.2 Public/private behavior:
- `DEST_CREATE_PUBLIC=0`: keep created channel private, continue.
- `DEST_CREATE_PUBLIC=1`: try assigning channel handle derived from `DEST_CHANNEL`.

2.3 Handle assignment when `DEST_CREATE_PUBLIC=1`:
- First try base handle.
- If occupied/invalid and `DEST_CREATE_CHANNEL_URI_AUTO_INCREMENT=1`, try suffixed candidates:
  - `base1`, `base2`, ... up to `DEST_CREATE_CHANNEL_URI_MAX_ATTEMPTS`.
- If no handle could be assigned:
  - `DEST_CREATE_FAIL_IF_HANDLE_TAKEN=1`: fail/exit.
  - `DEST_CREATE_FAIL_IF_HANDLE_TAKEN=0`: continue with created private channel.

3. State and posting
- Archive content source for `local2dest` is always loaded from local DB source-pair (`source->local-content`).
- Posting state is tracked per actual source->destination pair (destination-isolated mappings).
- Then normal post loop runs with skip/repost rules (`FORCE_REPOST`, etc.).
- `local2x`:
  - Loads prepared post units from `archive.db` + `channel-archive` (no source-channel scan/cache dependency).
  - Posts as X threads (one Telegram message -> one root post, long text auto-split into threaded parts using `X_MAX_TEXT_LENGTH`).
  - Requires `X_APP_KEY`, `X_APP_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`.
  - Uses DB state to skip already posted items per local2x run scope.
- `local2x-web`:
  - Loads prepared post units from `archive.db` + `channel-archive` (no source-channel scan/cache dependency).
  - Posts to X via browser automation (non-API).
  - Uses Playwright persistent profile in `X_WEB_PROFILE_DIR`.
  - First login seed: run with `X_WEB_HEADLESS=0`, sign in once, then rerun (headless optional).
  - Recommended stability settings: `X_WEB_BROWSER_CHANNEL=chrome`, `X_WEB_STEALTH=1`.
  - Media attach waits for preview + enabled post button before sending.
  - Uses DB state to skip already posted items per local2x-web run scope.
- `local2blogger`:
  - Loads prepared post units from `archive.db` + `channel-archive` (no source-channel scan/cache dependency).
  - API-only posting to Blogger.
  - Runs a preflight write check (creates/deletes one draft) and fails early if account cannot write to blog.
  - Uses Blogger-specific pacing via `BLOGGER_WAIT_MS` (or falls back to `WAIT_MS`).
  - Retries transient Blogger API failures (429/5xx/network/quota-like temporary failures) using `BLOGGER_RETRY_MAX` and `BLOGGER_RETRY_WAIT_MS`.
  - Optional batch cooldown every N posts via `BLOGGER_BATCH_EVERY` + `BLOGGER_BATCH_PAUSE_MS`.
  - Uses `post.txt` title as Blogger post title.
  - Places media block at top of post body.
  - Image files are embedded inline; non-image media are listed as attachment notes.
  - Publishes immediately (not draft).
  - Adds a share link to the created Blogger permalink.
  - Uses DB state to skip already posted items per source->blog pair.
  - `BLOGGER_RESET=1` wipes all existing posts in the target blog first, then clears local posted-state for that pair and reposts fresh.
- `local2wp.com`:
  - Loads prepared post units from `archive.db` + `channel-archive` (no source-channel scan/cache dependency).
  - API-only posting to WordPress.com.
  - Runs a preflight write check (creates/deletes one draft) and fails early if account cannot write to main site.
  - Uses `WP_COM_MAIN_SITE_ID` for post creation.
  - Uploads media to pool from `WP_COM_MEDIA_SITE_IDS` (or main site when empty).
  - Supports `WP_COM_MEDIA_STRATEGY=round-robin|fill-first` with optional failover (`WP_COM_MEDIA_FAILOVER=1`).
  - Uses `post.txt` title as WP post title.
  - Places media block at top of post body.
  - Publishes immediately.
  - If a media file cannot be uploaded to WordPress.com (file type/site restriction), post still publishes and the failed attachment is listed as a note in content.
  - Stores destination permalink in archive DB (`posts.destination_permalink`) for posted units.
  - Uses DB state to skip already posted items per source->wp-main-site pair.
  - `WP_COM_RESET=1` wipes all existing posts in the main site, deletes media from configured media pool sites, then clears local posted-state for that pair and reposts fresh.
- `local2insta`:
  - Parked/planned target command.
  - Not implemented yet.
- `local2bsky`:
  - Loads prepared post units from `archive.db` + `channel-archive` (no source-channel scan/cache dependency).
  - API-only posting to Bluesky.
  - Runs a preflight write check (create/delete probe post) and fails early if account cannot write.
  - Uses Bluesky-specific pacing via `BSKY_WAIT_MS` (or falls back to `WAIT_MS`).
  - Retries transient Bluesky API failures using `BSKY_RETRY_MAX` and `BSKY_RETRY_WAIT_MS`.
  - Uses DB state to skip already posted items per source->bsky pair.
  - `BSKY_RESET=1` wipes destination Bluesky posts for the authenticated account, clears local posted-state for that pair, then reposts fresh.
  - If `APPEND_DEST_PERMALINK_CHANNEL` is set, Telegram permalink lead uses that destination channel's pair (`handle`, `@handle`, or `t.me/handle`) when multiple destination pairs exist.
- `local2web-static-js`:
  - Generates static timeline export at `channel-archive/index.html` from archive DB + folder tree.
  - Includes media gallery, permalink anchors, and lazy-loading behavior.
  - If `APPEND_DEST_PERMALINK_CHANNEL` is set, permalink injection uses that destination channel's pair (`handle`, `@handle`, or `t.me/handle`); otherwise it falls back to latest destination pair.
- `local2x-webext-serv`:
  - Runs a localhost queue API from `archive.db` for browser extension posting.
  - Extension client lives in `webext/client` (load unpacked in Chrome).
  - API serves next job + media blobs and completion/fail callbacks.
- `POST_MODE=own-post` posts without Telegram's "forwarded" label.
- `POST_MODE=forwarded` is currently not supported in DB-only local publish modes (`local2dest`, `local2x`, `local2x-web`, `local2blogger`, `local2wp.com`, `local2bsky`).
- `TG_PREMIUM_POSTER=1` switches Telegram split/caption thresholds to the premium profile. Keep `0` for standard accounts.
- `DRY_RUN=true` prints what would be copied without posting.
- `FORCE_REPOST=true` ignores DB anti-duplicate skip and reposts even previously posted source messages.
- `WAIT_MS` uses a range (for example `1200-2200`) to control posting jitter between steps.
- `HEARTBEAT_LOG_MS` controls interval for long-running stage heartbeat logs (upload/download flood-wait and elapsed updates).
- Adaptive backoff (`FLOOD_BACKOFF_GAIN`, `FLOOD_BACKOFF_MAX_MS`, `FLOOD_BACKOFF_DECAY_MS`) increases delay after flood waits and decays it gradually.
- Flood cooldown is persisted in SQLite `meta`, so reruns honor active cooldown before making requests.
- `GRAMJS_LOG_LEVEL=error` keeps Telegram library internals quiet (set `info`/`debug` only when troubleshooting).
- Use `START_FROM_ID` / `END_AT_ID` to process only a message ID range.
- Use `START_FROM_DATE` / `END_AT_DATE` to process only a message date/time range (`YYYY-MM-DD` or ISO datetime).
  - If `START_FROM_DATE` has no posts on that day, the nearest earlier available post date is used.
  - If `END_AT_DATE` has no posts on that day, the nearest later available post date is used.
- Use `START_FROM_COUNT` / `END_AT_COUNT` to process only a 1-based loop range.
- File cache (`FILE_CACHE_ENABLED=1`) is always full-scan cache; ID/date filters limit only processing selection, not cached scan scope.
- Local archive is always enabled in `channel-archive/`:
  - Each post gets folder `YYYY-MM-DD_HH-mm-ss__msg-<id>`.
  - Each folder contains `post.txt` + media files.
- SQLite is the central state in `channel-archive/archive.db`:
  - Stores post metadata (`posts`) and media paths (`media_files`).
  - Stores sync/post progress and ID mappings (`clone_messages`) to prevent duplicate reposts on rerun.
- For private invite links, the script resolves and joins automatically when needed.
- Destination auto-create envs (local2dest):
  - `DEST_AUTO_CREATE=1` enables fallback creation when `DEST_CHANNEL` cannot be resolved.
  - `DEST_CREATE_PUBLIC=1` requests a public channel; this requires a valid destination channel handle.
  - `DEST_CREATE_TITLE` / `DEST_CREATE_ABOUT` set created channel metadata.
  - `DEST_CREATE_ICON` sets channel icon from a local image file path during auto-create.
  - `DEST_CREATE_DISABLE_REACTIONS=1` disables reactions on newly created destination channel.
  - `DEST_CREATE_FAIL_IF_HANDLE_TAKEN=1` fails when no handle can be assigned.
  - `DEST_CREATE_CHANNEL_URI_AUTO_INCREMENT=1` tries suffixed handle candidates.
  - `DEST_CREATE_CHANNEL_URI_MAX_ATTEMPTS` caps candidate attempts.
- In `own-post` mode, the script preserves filename/mime hints to avoid files appearing as generic `application/octet-stream`.
- Grouped Telegram posts (albums with the same `groupedId`) are preserved as one grouped post in destination.
- In `own-post` mode, links in post text/captions are cleaned:
  - Removes tracking query params matching `utm_*`, `trk`, `trk_*`, and `originalSubdomain`.
  - Removes all Telegram links (`t.me` / `telegram.me`) from text.
  - Then applies JSON text rules from `TEXT_RULES_FILE`.
- Long captions are handled automatically:
  - Media caption is trimmed to an internal Telegram profile limit (standard or premium via `TG_PREMIUM_POSTER`).
  - Overflow text is sent immediately after as regular message chunks.
- X posting preserves line breaks/spacing from archived text and splits by safe chunk size (`X_MAX_TEXT_LENGTH`, default `260`).
- Respect Telegram terms and copyright/licensing rules for content you copy.

## Blogger API Credentials (for `local2blogger`)

`local2blogger` is API-only mode. Credential setup:

1. Open `https://console.cloud.google.com/` and create/select a project.
2. Enable `Blogger API v3`:
   - Go to `APIs & Services` -> `Library`
   - Search for `Blogger API`
   - Open it and click `Enable`
   - Direct link: `https://console.cloud.google.com/apis/library/blogger.googleapis.com`
3. Configure OAuth consent screen.
   - In `Audience`, choose `External` for normal personal/testing use.
   - Use `Internal` only if you have a Google Workspace organization and all users are inside it.
   - Keep app in `Testing` and add your Google account under `Test users`.
4. Create OAuth client:
   - `APIs & Services` -> `Credentials` -> `Create Credentials` -> `OAuth client ID`
   - Choose `Web application` (recommended when using OAuth Playground)
   - Add authorized redirect URI exactly:
     - `https://developers.google.com/oauthplayground`
5. Copy:
   - `BLOGGER_CLIENT_ID`
   - `BLOGGER_CLIENT_SECRET`
6. Generate a refresh token with scope:
   - `https://www.googleapis.com/auth/blogger`
7. Easiest method:
   - Open `https://developers.google.com/oauthplayground/`
   - Enable `Use your own OAuth credentials`
   - Paste client ID/secret
   - Authorize scope and exchange code
   - Copy `refresh_token` into `BLOGGER_REFRESH_TOKEN`
   - In Step 2, click `Exchange authorization code for tokens`
   - Wait for response and copy `Refresh token`
   - Save it in `.env` as `BLOGGER_REFRESH_TOKEN=...`
8. Important consistency rule:
   - `BLOGGER_CLIENT_ID` + `BLOGGER_CLIENT_SECRET` used at runtime must belong to the same OAuth client that minted `BLOGGER_REFRESH_TOKEN`.
   - If they do not match, token refresh fails with 401 (`invalid_grant` / `Unauthorized`).

Troubleshooting (`Error 400: redirect_uri_mismatch`):
- Cause: OAuth Playground callback URL is not allowed for your OAuth client.
- Fix:
  1. In Google Cloud Console -> `APIs & Services` -> `Credentials`
  2. Use OAuth client type `Web application`
  3. Add authorized redirect URI exactly:
     - `https://developers.google.com/oauthplayground`
  4. Save, then use this Web client ID/secret in OAuth Playground settings.

Troubleshooting (`Blogger OAuth token refresh failed (401): Unauthorized`):
- Cause: refresh token does not belong to the same OAuth client configured in `BLOGGER_CLIENT_ID` / `BLOGGER_CLIENT_SECRET`, or token was revoked.
- Fix:
  1. In OAuth Playground, keep `Use your own OAuth credentials` enabled.
  2. Paste the same client ID/secret you plan to keep in `.env`.
  3. Re-authorize scope `https://www.googleapis.com/auth/blogger`.
  4. Exchange code and replace `BLOGGER_REFRESH_TOKEN` in `.env`.
  5. Retry `npm run local2blogger`.

Troubleshooting (`Error 403: access_denied` during OAuth authorization):
- Cause: app is in Testing mode and your Google account is not added as a test user.
- Fix:
  1. Go to Google Cloud Console -> `APIs & Services` -> `OAuth consent screen`
  2. Open `Audience`
  3. Under `Test users`, click `Add users`
  4. Add the exact Gmail account you are signing in with
  5. Save and wait 1-5 minutes
  6. Retry OAuth Playground authorization

Troubleshooting (no refresh token returned):
- In OAuth Playground settings, keep `Use your own OAuth credentials` enabled.
- Ensure request uses offline access (`access_type=offline`).
- Re-run Step 1 with consent prompt, then exchange code again in Step 2.

Add to `.env`:

```env
BLOGGER_CLIENT_ID=
BLOGGER_CLIENT_SECRET=
BLOGGER_REFRESH_TOKEN=
BLOGGER_BLOG_ID=
# or BLOGGER_BLOG_URL=https://yourblog.blogspot.com
BLOGGER_TAGS=
BLOGGER_RESET=0
BLOGGER_WAIT_MS=
BLOGGER_BATCH_EVERY=0
BLOGGER_BATCH_PAUSE_MS=0-0
BLOGGER_RETRY_MAX=3
BLOGGER_RETRY_WAIT_MS=2500-6000
```

Current API limitation:
- Blogger API v3 can create/update/delete posts, but there is no public API method to create a brand-new blog/site from scratch.

## WordPress.com API Credentials (for `local2wp.com`)

`local2wp.com` will be API-only mode. Prepare these values in advance:

- `WP_COM_CLIENT_ID`
- `WP_COM_CLIENT_SECRET`
- `WP_COM_USERNAME`
- `WP_COM_APP_PASSWORD`
- `WP_COM_MAIN_SITE_ID`
- `WP_COM_MEDIA_SITE_IDS`
- `WP_COM_MEDIA_STRATEGY`
- `WP_COM_MEDIA_FAILOVER`
- `WP_COM_TAGS`
- `WP_COM_RESET`
- `WP_COM_WAIT_MS`
- `WP_COM_BATCH_EVERY`
- `WP_COM_BATCH_PAUSE_MS`
- `WP_COM_RETRY_MAX`
- `WP_COM_RETRY_WAIT_MS`

### 1) Get `WP_COM_CLIENT_ID` and `WP_COM_CLIENT_SECRET`

1. Sign in to WordPress.com with the account that owns/can post to your site.
2. Open `https://developer.wordpress.com/apps/`.
3. Create a new OAuth2 application (or open an existing one).
4. Copy:
   - **Client ID** -> `WP_COM_CLIENT_ID`
   - **Client Secret** -> `WP_COM_CLIENT_SECRET`

Notes:
- Keep these secrets private.
- Use one app per environment when possible (dev/prod split).

### 2) Get `WP_COM_USERNAME`

Use your WordPress.com account username (not email) for `WP_COM_USERNAME`.

You can verify it at:
- `https://wordpress.com/me/account`

### 3) Get `WP_COM_APP_PASSWORD`

1. Open your account security settings (`https://wordpress.com/me/security`).
2. Ensure account password is set.
3. Enable **Two-Step Authentication**.
4. Open the Two-Step/Application Passwords section.
5. Create an **Application Password** for this project.
6. Copy the generated password to `WP_COM_APP_PASSWORD`.

Important:
- WordPress.com application passwords are not shown until password + 2FA prerequisites are completed.

Security notes:
- Treat it like a real password.
- If leaked, revoke it immediately and generate a new one.

### 4) Get site IDs for main + media pool

Preferred:
- Use numeric site identifiers for all targets.

Alternatives to find it:
1. Use site URL lookup endpoint in browser:
   - `https://public-api.wordpress.com/rest/v1.1/sites/<your-site-domain-or-subdomain>`
   - Example: `.../sites/example.wordpress.com`
2. In the JSON response, copy `ID`.
3. Assign IDs:
   - `WP_COM_MAIN_SITE_ID=<main blog site id>`
   - `WP_COM_MEDIA_SITE_IDS=<media site id 1>,<media site id 2>,...`

Example:
- Main site hosts posts/content.
- Media sites host uploaded media blobs used in those posts.

### 5) Multi-site media behavior

- `WP_COM_MEDIA_STRATEGY=round-robin`
  - rotate uploads across media sites evenly.
- `WP_COM_MEDIA_STRATEGY=fill-first`
  - keep using first media site until failure/quota, then move to next.
- `WP_COM_MEDIA_FAILOVER=1`
  - if selected media site fails upload, try next media site automatically.

### 6) Add to `.env`

```env
WP_COM_CLIENT_ID=
WP_COM_CLIENT_SECRET=
WP_COM_USERNAME=
WP_COM_APP_PASSWORD=
WP_COM_MAIN_SITE_ID=
WP_COM_MEDIA_SITE_IDS=
WP_COM_MEDIA_STRATEGY=round-robin
WP_COM_MEDIA_FAILOVER=1
WP_COM_TAGS=
WP_COM_RESET=0
WP_COM_WAIT_MS=4000-9000
WP_COM_BATCH_EVERY=15
WP_COM_BATCH_PAUSE_MS=30000-90000
WP_COM_RETRY_MAX=4
WP_COM_RETRY_WAIT_MS=4000-10000
```

### 7) Typical auth/setup pitfalls

- `invalid_client`: wrong `WP_COM_CLIENT_ID`/`WP_COM_CLIENT_SECRET`.
- `invalid_grant`: wrong username/app password pair.
- `403` posting errors: account token has no write access to one or more configured sites.
- Wrong site target: `WP_COM_MAIN_SITE_ID` or entries in `WP_COM_MEDIA_SITE_IDS` point to a different site than expected.
- Media-only site suspended/quota-hit can break uploads unless failover is enabled.

## Bluesky API Credentials (for `local2bsky`)

`local2bsky` is API-only mode.

Planned required values:

- `BSKY_IDENTIFIER` (account handle/identifier)
- `BSKY_APP_PASSWORD` (Bluesky app password)
- `BSKY_SERVICE_URL` (default `https://bsky.social`)
- `BSKY_ENABLE_VIDEO`
- `BSKY_WAIT_MS`
- `BSKY_RETRY_MAX`
- `BSKY_RETRY_WAIT_MS`
- `BSKY_POLL_MS`
- `BSKY_TAGS`
- `BSKY_TEXT_MAX`
- `BSKY_IMAGES_MAX`
- `BSKY_IMAGE_MAX_BYTES`
- `BSKY_RESET`

Planned behavior:
- API login via identifier + app password.
- Archive-to-post conversion with Bluesky-safe limits.
- Up to 4 images per post unit; larger sets split into thread sequence.
- Optional video path (separate upload/poll flow) when enabled.
- Local posted-state skip logic, with optional reset (`BSKY_RESET`).
- `BSKY_RESET=1` wipes existing destination posts first, then clears local posted-state for that source->bsky pair and reposts fresh.

## Web Extension Mode (Local Server + Unpacked Chrome Extension)

1. Start the local queue server:

```bash
npm run local2x-webext-serv
```

2. In Chrome, open `chrome://extensions`, enable Developer mode, then Load unpacked:
   - Select `webext/client`
3. Open `https://x.com/home` in a tab.
4. Open extension popup, set:
   - `Server URL` (default `http://127.0.0.1:37891`)
   - `Server Token` (if `WEBEXT_SERVER_TOKEN` set)
   - `Poll ms`
   - `X split length`
5. Click `Start`.

Notes:
- Keep at least one `x.com` tab open while posting.
- Queue source is `channel-archive/archive.db` posts + `media_files`.
- Completed/failed IDs are persisted in `webext/serv/state.json`.

## License

This project is licensed under **GNU GPL v3.0 only** (`GPL-3.0-only`).
See [LICENSE](LICENSE).
