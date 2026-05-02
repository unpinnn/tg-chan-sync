# TODO

## Command status (current)
- `src2local`: implemented; active.
- `local2dest`: implemented; active.
- `local2x`: implemented, but parked for full end-to-end verification.
- `local2x-web`: implemented, but parked for full end-to-end verification.
- `local2blogger`: implemented, but parked for larger real-world validation.
- `local2wp.com`: implemented, but parked for larger real-world validation.
- `local2insta`: parked/planned (not implemented yet).
- `local2bsky`: implemented, parked for larger real-world validation.
- `local2web-static-js`: implemented; active.
- `local2x-webext-serv`: implemented, parked at checkpoint for later pickup.

1. `local2x`: must be tested. It is currently completely left parked. (implementation as well as verification of it)

2. `local2x-web`

2.a The `post.txt`, the accompanied images, and the information at DB level are not fit for 1 tweet.
Because of that, splitting is needed:

2a1. Text: the text is currently cut, not split. If text is long, the tweet keeps only up to a point and the rest is lost.

2a2. Attachments: posts with more attachments than allowed are getting posted as text-only.
X limit note (as of April 27, 2026):
- up to 4 photos per post
- or 1 animated GIF
- or 1 video

3. `local2x-webext-serv` checkpoint (freeze point for later pickup)
- Last verified: 2026-04-27
- Resume-from commit: `<fill-after-next-commit>`

3.a What is implemented now:
- Command: `npm run local2x-webext-serv`
- Server: `webext/serv/main.js` serves job queue + media files + `/logs` endpoint.
- Client extension: `webext/client/**` works as unpacked Chrome extension.
- Popup controls: start/stop/status + config fields (`server url`, `token`, `poll ms`, `max text length`, `post interval range`).
- Content script loop:
  - pulls next job from server,
  - splits long text into chunks for X,
  - splits media into X-compatible batches (up to 4 photos/group; non-photo media as single),
  - posts group/thread sequence with random wait from configured range.
- In-page overlay:
  - current status,
  - click-to-expand recent history.
- Extension logs are sent back to server terminal through `/logs` (`[webext-log] ...` lines).
- Post button activation helper exists:
  - periodic typing nudge (`az` then delete) while waiting for Post button to enable,
  - enable timeout currently 30s.

3.b Known issues still open:
- Some jobs still fail with `Post button disabled (timeout waiting enabled ...)`.
- Composer/upload readiness detection is heuristic; can still race in some sessions.
- Failure recovery is basic: job marked failed, then loop continues to next job.
- No dedicated "retry N times before fail" policy yet.

3.c Resume exactly from here (next engineering step):
1. Improve composer readiness gate before clicking Post:
- wait for media thumbnail chips/previews to appear and settle,
- re-resolve post button element each cycle (DOM can re-render),
- verify editor still focused/attached.
2. Add controlled retry policy per job:
- retry same job on transient UI failures (`post button disabled`, transient selector misses),
- exponential backoff + jitter before final fail mark.
3. Add explicit success confirmation after click:
- detect compose close/success toast/tweet creation signal before marking complete.
4. Add richer fail telemetry in `/logs`:
- include selector snapshot + state flags (button disabled, aria-disabled, media count loaded).

4. `local2blogger`
- Verify end-to-end publishing on a real blog with mixed media posts (images + non-image files).
- Validate share-link update pass on very long HTML bodies.
- Confirm reset behavior (`BLOGGER_RESET=1`) on large blogs (multi-page post deletion).

5. `local2wp.com` (implemented, parked for verification)
- API-only WordPress.com adapter with shared account creds.
- Multi-site layout:
  - `WP_COM_MAIN_SITE_ID` for post publishing.
  - `WP_COM_MEDIA_SITE_IDS` for media hosting pool.
- Media placement strategy:
  - `WP_COM_MEDIA_STRATEGY=round-robin|fill-first`
  - `WP_COM_MEDIA_FAILOVER=1` fallback across pool.
- Per-target pacing and retries:
  - `WP_COM_WAIT_MS`
  - `WP_COM_BATCH_EVERY` + `WP_COM_BATCH_PAUSE_MS`
  - `WP_COM_RETRY_MAX` + `WP_COM_RETRY_WAIT_MS`
- Reset mode:
  - `WP_COM_RESET=1` wipes existing posts on main site, deletes media on configured media site pool, and clears local posted-state for source->wp pair.
- Remaining verification:
  - Run long real-world migrations with mixed image/video/non-image posts and confirm desired behavior.
  - Confirm media-site failover behavior under quota/type restrictions.
  - Confirm reset behavior on large media libraries (performance + limits).

6. `local2insta` (parked)
- Status: parked; do not implement yet.
- Mode: API-first only (no web automation).

6.a Planned implementation steps:
1. Add command + target profile:
- `npm run local2insta` (registered command path; target still unimplemented).
2. Build `insta-client.service.js`:
- token/auth check
- create media container(s)
- publish container
- poll processing for video/carousel readiness.
3. Build `insta.target.js`:
- map archive `post.txt` + media to Instagram publish units
- enforce IG-safe media rules
- persist posted mapping in DB for skip-on-rerun.
4. Add preflight:
- verify token + publish permission before loop
- fail once up front with a clear error.
5. Add pacing/retry:
- target-specific wait/retry/poll controls.

6.b Known API/product constraints to design around:
- Caption constraints are stricter than Telegram; must clamp/split strategy for Instagram.
- Unsupported Telegram attachment types (docs/audio/other non-IG media) cannot be uploaded.
- Video posting requires processing/polling and can take longer.
- Reset semantics differ from Telegram:
  - default `INSTA_RESET` should clear local posted-state only unless hard-delete path is confirmed.
- Carousel max should be enforced at 10 media items per publish unit.

6.c Auth-path decision (required before implementation):
- Choose one and freeze:
1. Instagram API with Instagram Login (preferred modern path), or
2. Facebook Login + Instagram Graph (classic path).

6.d Proposed env contract:
- `INSTA_CLIENT_ID=`
- `INSTA_CLIENT_SECRET=`
- `INSTA_ACCESS_TOKEN=`
- `INSTA_IG_USER_ID=`
- `INSTA_FB_PAGE_ID=` (only for Facebook-login route)
- `INSTA_WAIT_MS=4000-9000`
- `INSTA_RETRY_MAX=4`
- `INSTA_RETRY_WAIT_MS=4000-10000`
- `INSTA_POLL_MS=5000-12000`
- `INSTA_TAGS=`
- `INSTA_CAPTION_MAX=2200`
- `INSTA_CAROUSEL_MAX=10`
- `INSTA_RESET=0`

7. `local2bsky` (implemented, parked for verification)
- Status: implemented; validate end-to-end behavior at scale.
- Mode: API-first only (no browser automation).

7.a Implemented now:
1. Command + target profile:
- `npm run local2bsky` is registered and routed.
2. `bsky-client.service.js`:
- auth/session creation (identifier + app password),
- blob upload for images/files,
- record create/delete/list helpers for ATProto.
3. `bsky.target.js`:
- maps archive content into Bluesky-safe post units,
- enforces text/media limits and threads when needed,
- persists posted mapping through existing DB state flow.
4. Preflight:
- verifies login/session and write access before posting pass.
5. Reset:
- `BSKY_RESET=1` deletes destination posts and clears local posted-state for the pair.
6. Pacing/retry:
- target-specific pacing via `BSKY_WAIT_MS`,
- retry/wait controls via `BSKY_RETRY_MAX` and `BSKY_RETRY_WAIT_MS`.

7.b Known API/product constraints to design around:
- Post text length is constrained by Bluesky post schema (`app.bsky.feed.post`), currently treated as ~300 graphemes.
- Image embed limit: up to 4 images per post.
- Image size guidance: currently documented as max 1,000,000 bytes per image in Bluesky post guide.
- Non-image attachments cannot be represented like Telegram docs; fallback should be link/note text.
- Video posting uses separate upload/processing flow and may require verified email + account-level daily limits.
- Reset semantics differ from Telegram:
  - `BSKY_RESET=1` should delete existing destination posts first, then clear local posted-state for the active source->bsky pair and repost from archive.
  - `BSKY_RESET=0` remains default safe mode.

7.c Auth prerequisites to collect before implementation:
- Bluesky account handle (for example `name.bsky.social` or custom domain handle).
- Bluesky App Password for API login.
- Optional: decision whether to enable video uploads in first release (`BSKY_ENABLE_VIDEO=0|1`).

7.d Proposed env contract:
- `BSKY_IDENTIFIER=` (handle or login identifier)
- `BSKY_APP_PASSWORD=`
- `BSKY_SERVICE_URL=https://bsky.social`
- `BSKY_ENABLE_VIDEO=0`
- `BSKY_WAIT_MS=2000-6000`
- `BSKY_RETRY_MAX=4`
- `BSKY_RETRY_WAIT_MS=3000-9000`
- `BSKY_POLL_MS=2000-8000`
- `BSKY_TAGS=` (optional hashtags/tags to append)
- `BSKY_TEXT_MAX=300`
- `BSKY_IMAGES_MAX=4`
- `BSKY_IMAGE_MAX_BYTES=1000000`
- `BSKY_RESET=0`

