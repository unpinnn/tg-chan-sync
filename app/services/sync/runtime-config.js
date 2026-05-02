const path = require("path");
const dotenv = require("dotenv");
const { createActiveScopeRef } = require("../../models/sync-scope.model");
const {
  parseEnvDateBoundary,
  parseFiniteNumber,
  parseMsRange,
  parsePositiveIntEnv
} = require("./runtime-env");

dotenv.config();

const TELEGRAM_LIMITS_STANDARD = Object.freeze({
  maxMediaCaptionLength: 1024,
  maxTextMessageLength: 4096
});

const TELEGRAM_LIMITS_PREMIUM = Object.freeze({
  maxMediaCaptionLength: 2048,
  maxTextMessageLength: 4096
});

function loadRuntimeConfig(env = process.env) {
  const REQUIRED_ENV = ["SOURCE_CHANNEL"];
  for (const key of REQUIRED_ENV) {
    if (!env[key]) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }

  const POST_MODE = String(env.POST_MODE || "").toLowerCase();
  if (!["own-post", "forwarded"].includes(POST_MODE)) {
    throw new Error("POST_MODE must be either 'own-post' or 'forwarded'.");
  }

  const WAIT_MS_RAW = String(env.WAIT_MS || "1200-2200").trim();
  const WAIT_RANGE_DEFAULT = parseMsRange(WAIT_MS_RAW, "WAIT_MS", { min: 1200, max: 2200 }, true);
  const WAIT_RANGE_POST = WAIT_RANGE_DEFAULT;
  const BLOGGER_WAIT_MS_RAW = String(env.BLOGGER_WAIT_MS || "").trim();
  const WAIT_RANGE_BLOGGER = BLOGGER_WAIT_MS_RAW
    ? parseMsRange(BLOGGER_WAIT_MS_RAW, "BLOGGER_WAIT_MS", WAIT_RANGE_POST, true)
    : WAIT_RANGE_POST;
  const WP_COM_WAIT_MS_RAW = String(env.WP_COM_WAIT_MS || "").trim();
  const WAIT_RANGE_WPCOM = WP_COM_WAIT_MS_RAW
    ? parseMsRange(WP_COM_WAIT_MS_RAW, "WP_COM_WAIT_MS", WAIT_RANGE_POST, true)
    : WAIT_RANGE_POST;
  const BSKY_WAIT_MS_RAW = String(env.BSKY_WAIT_MS || "").trim();
  const WAIT_RANGE_BSKY = BSKY_WAIT_MS_RAW
    ? parseMsRange(BSKY_WAIT_MS_RAW, "BSKY_WAIT_MS", WAIT_RANGE_POST, true)
    : WAIT_RANGE_POST;

  const START_FROM_DATE = parseEnvDateBoundary(
    String(env.START_FROM_DATE || ""),
    false,
    "START_FROM_DATE"
  );
  const END_AT_DATE = parseEnvDateBoundary(String(env.END_AT_DATE || ""), true, "END_AT_DATE");
  if (START_FROM_DATE && END_AT_DATE && START_FROM_DATE.getTime() > END_AT_DATE.getTime()) {
    throw new Error("START_FROM_DATE cannot be later than END_AT_DATE.");
  }
  const START_FROM_DATE_MS = START_FROM_DATE ? START_FROM_DATE.getTime() : 0;
  const END_AT_DATE_MS = END_AT_DATE ? END_AT_DATE.getTime() : 0;
  const xMaxTextLengthRaw = parsePositiveIntEnv(env.X_MAX_TEXT_LENGTH, 260, "X_MAX_TEXT_LENGTH");
  const X_MAX_TEXT_LENGTH =
    xMaxTextLengthRaw === 0 ? 260 : Math.max(40, Math.min(280, xMaxTextLengthRaw));
  const TG_PREMIUM_POSTER = /^(1|true)$/i.test(String(env.TG_PREMIUM_POSTER || "0"));
  const telegramLimits = TG_PREMIUM_POSTER ? TELEGRAM_LIMITS_PREMIUM : TELEGRAM_LIMITS_STANDARD;
  const ARCHIVE_ROOT_INPUT = String(env.LOCAL_ARCHIVE_DIR || "channel-archive").trim();
  const ARCHIVE_ROOT = path.resolve(ARCHIVE_ROOT_INPUT || "channel-archive");

  return {
    API_HASH: env.TG_API_HASH,
    API_ID: Number(env.TG_API_ID),
    APPEND_DEST_PERMALINK: /^(1|true)$/i.test(env.APPEND_DEST_PERMALINK || "0"),
    APPEND_DEST_PERMALINK_TXT: String(env.APPEND_DEST_PERMALINK_TXT || ""),
    APPEND_DEST_PERMALINK_CHANNEL: String(env.APPEND_DEST_PERMALINK_CHANNEL || "").trim(),
    ARCHIVE_DIR: ARCHIVE_ROOT,
    ARCHIVE_DB_PATH: path.resolve(ARCHIVE_ROOT, "archive.db"),
    DEST_CHANNEL: env.DEST_CHANNEL,
    DEST_AUTO_CREATE: /^(1|true)$/i.test(env.DEST_AUTO_CREATE || "0"),
    DEST_CREATE_PUBLIC: /^(1|true)$/i.test(env.DEST_CREATE_PUBLIC || "0"),
    DEST_CREATE_TITLE: String(env.DEST_CREATE_TITLE || "").trim(),
    DEST_CREATE_ABOUT: String(env.DEST_CREATE_ABOUT || "").trim(),
    DEST_CREATE_ICON: String(env.DEST_CREATE_ICON || "").trim()
      ? path.resolve(String(env.DEST_CREATE_ICON || "").trim())
      : "",
    DEST_CREATE_DISABLE_REACTIONS: /^(1|true)$/i.test(env.DEST_CREATE_DISABLE_REACTIONS || "0"),
    DEST_CREATE_FAIL_IF_HANDLE_TAKEN: /^(1|true)$/i.test(
      env.DEST_CREATE_FAIL_IF_HANDLE_TAKEN || "1"
    ),
    DEST_CREATE_CHANNEL_URI_AUTO_INCREMENT: /^(1|true)$/i.test(
      env.DEST_CREATE_CHANNEL_URI_AUTO_INCREMENT || "0"
    ),
    DEST_CREATE_CHANNEL_URI_MAX_ATTEMPTS: Math.max(
      1,
      parsePositiveIntEnv(
        env.DEST_CREATE_CHANNEL_URI_MAX_ATTEMPTS,
        50,
        "DEST_CREATE_CHANNEL_URI_MAX_ATTEMPTS"
      ) || 50
    ),
    DEST_RESET: /^(1|true)$/i.test(env.DEST_RESET || "0"),
    BLOGGER_CLIENT_ID: String(env.BLOGGER_CLIENT_ID || "").trim(),
    BLOGGER_CLIENT_SECRET: String(env.BLOGGER_CLIENT_SECRET || "").trim(),
    BLOGGER_REFRESH_TOKEN: String(env.BLOGGER_REFRESH_TOKEN || "").trim(),
    BLOGGER_BLOG_ID: String(env.BLOGGER_BLOG_ID || "").trim(),
    BLOGGER_BLOG_URL: String(env.BLOGGER_BLOG_URL || "").trim(),
    BLOGGER_TAGS: String(env.BLOGGER_TAGS || "").trim(),
    BLOGGER_RESET: /^(1|true)$/i.test(env.BLOGGER_RESET || "0"),
    BLOGGER_BATCH_EVERY: parsePositiveIntEnv(env.BLOGGER_BATCH_EVERY, 0, "BLOGGER_BATCH_EVERY"),
    BLOGGER_BATCH_PAUSE_RANGE: parseMsRange(
      String(env.BLOGGER_BATCH_PAUSE_MS || "0-0").trim(),
      "BLOGGER_BATCH_PAUSE_MS",
      { min: 0, max: 0 },
      true
    ),
    BLOGGER_RETRY_MAX: parsePositiveIntEnv(env.BLOGGER_RETRY_MAX, 3, "BLOGGER_RETRY_MAX"),
    BLOGGER_RETRY_WAIT_RANGE: parseMsRange(
      String(env.BLOGGER_RETRY_WAIT_MS || "2500-6000").trim(),
      "BLOGGER_RETRY_WAIT_MS",
      { min: 2500, max: 6000 },
      true
    ),
    WP_COM_CLIENT_ID: String(env.WP_COM_CLIENT_ID || "").trim(),
    WP_COM_CLIENT_SECRET: String(env.WP_COM_CLIENT_SECRET || "").trim(),
    WP_COM_USERNAME: String(env.WP_COM_USERNAME || "").trim(),
    WP_COM_APP_PASSWORD: String(env.WP_COM_APP_PASSWORD || "").trim(),
    WP_COM_MAIN_SITE_ID: String(env.WP_COM_MAIN_SITE_ID || "").trim(),
    WP_COM_MEDIA_SITE_IDS: String(env.WP_COM_MEDIA_SITE_IDS || "").trim(),
    WP_COM_MEDIA_STRATEGY: String(env.WP_COM_MEDIA_STRATEGY || "round-robin")
      .trim()
      .toLowerCase(),
    WP_COM_MEDIA_FAILOVER: /^(1|true)$/i.test(env.WP_COM_MEDIA_FAILOVER || "1"),
    WP_COM_TAGS: String(env.WP_COM_TAGS || "").trim(),
    WP_COM_RESET: /^(1|true)$/i.test(env.WP_COM_RESET || "0"),
    WP_COM_BATCH_EVERY: parsePositiveIntEnv(env.WP_COM_BATCH_EVERY, 0, "WP_COM_BATCH_EVERY"),
    WP_COM_BATCH_PAUSE_RANGE: parseMsRange(
      String(env.WP_COM_BATCH_PAUSE_MS || "0-0").trim(),
      "WP_COM_BATCH_PAUSE_MS",
      { min: 0, max: 0 },
      true
    ),
    WP_COM_RETRY_MAX: parsePositiveIntEnv(env.WP_COM_RETRY_MAX, 4, "WP_COM_RETRY_MAX"),
    WP_COM_RETRY_WAIT_RANGE: parseMsRange(
      String(env.WP_COM_RETRY_WAIT_MS || "4000-10000").trim(),
      "WP_COM_RETRY_WAIT_MS",
      { min: 4000, max: 10000 },
      true
    ),
    BSKY_IDENTIFIER: String(env.BSKY_IDENTIFIER || "").trim(),
    BSKY_APP_PASSWORD: String(env.BSKY_APP_PASSWORD || "").trim(),
    BSKY_SERVICE_URL: String(env.BSKY_SERVICE_URL || "https://bsky.social").trim(),
    BSKY_ENABLE_VIDEO: /^(1|true)$/i.test(env.BSKY_ENABLE_VIDEO || "0"),
    BSKY_TAGS: String(env.BSKY_TAGS || "").trim(),
    BSKY_RESET: /^(1|true)$/i.test(env.BSKY_RESET || "0"),
    BSKY_TEXT_MAX: Math.max(20, parsePositiveIntEnv(env.BSKY_TEXT_MAX, 300, "BSKY_TEXT_MAX") || 300),
    BSKY_IMAGES_MAX: Math.max(
      1,
      Math.min(4, parsePositiveIntEnv(env.BSKY_IMAGES_MAX, 4, "BSKY_IMAGES_MAX") || 4)
    ),
    BSKY_IMAGE_MAX_BYTES: Math.max(
      10000,
      parsePositiveIntEnv(env.BSKY_IMAGE_MAX_BYTES, 1000000, "BSKY_IMAGE_MAX_BYTES") || 1000000
    ),
    BSKY_RETRY_MAX: parsePositiveIntEnv(env.BSKY_RETRY_MAX, 4, "BSKY_RETRY_MAX"),
    BSKY_RETRY_WAIT_RANGE: parseMsRange(
      String(env.BSKY_RETRY_WAIT_MS || "3000-9000").trim(),
      "BSKY_RETRY_WAIT_MS",
      { min: 3000, max: 9000 },
      true
    ),
    BSKY_POLL_RANGE: parseMsRange(
      String(env.BSKY_POLL_MS || "2000-8000").trim(),
      "BSKY_POLL_MS",
      { min: 2000, max: 8000 },
      true
    ),
    DOWNLOAD_CONCURRENCY: Math.max(1, Number(env.DOWNLOAD_CONCURRENCY || 1)),
    DRY_RUN: /^true$/i.test(env.DRY_RUN || "false"),
    END_AT_COUNT: Number(env.END_AT_COUNT || 0),
    END_AT_DATE,
    END_AT_DATE_MS,
    END_AT_ID: Number(env.END_AT_ID || 0),
    FILE_CACHE_ENABLED: /^(1|true)$/i.test(env.FILE_CACHE_ENABLED || "0"),
    FILE_CACHE_PATH: path.resolve(env.FILE_CACHE_PATH || "./cache"),
    FILE_CACHE_TTL: String(env.FILE_CACHE_TTL || "10080m"),
    FLOOD_BACKOFF_DECAY_MS: parsePositiveIntEnv(
      env.FLOOD_BACKOFF_DECAY_MS,
      300,
      "FLOOD_BACKOFF_DECAY_MS"
    ),
    FLOOD_BACKOFF_GAIN: parseFiniteNumber(env.FLOOD_BACKOFF_GAIN, 0.5, "FLOOD_BACKOFF_GAIN"),
    FLOOD_BACKOFF_MAX_MS: parsePositiveIntEnv(
      env.FLOOD_BACKOFF_MAX_MS,
      120000,
      "FLOOD_BACKOFF_MAX_MS"
    ),
    FORCE_REPOST: /^(1|true)$/i.test(env.FORCE_REPOST || "0"),
    GRAMJS_LOG_LEVEL: String(env.GRAMJS_LOG_LEVEL || "error").toLowerCase(),
    HEARTBEAT_LOG_MS: Math.max(
      1000,
      parsePositiveIntEnv(env.HEARTBEAT_LOG_MS, 8000, "HEARTBEAT_LOG_MS")
    ),
    MAX_GRAMJS_BUFFER_UPLOAD: 20 * 1024 * 1024 - 1,
    MAX_MEDIA_CAPTION_LENGTH: telegramLimits.maxMediaCaptionLength,
    MAX_TEXT_MESSAGE_LENGTH: telegramLimits.maxTextMessageLength,
    POST_AUTOPREPEND_LINE1: String(env.POST_AUTOPREPEND_LINE1 || ""),
    POST_AUTOPREPEND_LINE2: String(env.POST_AUTOPREPEND_LINE2 || ""),
    POST_AUTOAPPEND_LINE1: String(env.POST_AUTOAPPEND_LINE1 || ""),
    POST_AUTOAPPEND_LINE2: String(env.POST_AUTOAPPEND_LINE2 || ""),
    POST_AUTOSPLIT_TXT_HEADER_1: String(env.POST_AUTOSPLIT_TXT_HEADER_1 || "1/2"),
    POST_AUTOSPLIT_TXT_FOOTER_1: String(env.POST_AUTOSPLIT_TXT_FOOTER_1 || ""),
    POST_AUTOSPLIT_TXT_HEADER_2: String(env.POST_AUTOSPLIT_TXT_HEADER_2 || "2/2"),
    POST_MODE,
    PROGRESS_MIN_UPDATE_MS: 200,
    SHOW_PROGRESS: /^(1|true)$/i.test(env.SHOW_PROGRESS || "0"),
    SOURCE_CHANNEL: env.SOURCE_CHANNEL,
    START_FROM_COUNT: Number(env.START_FROM_COUNT || 0),
    START_FROM_DATE,
    START_FROM_DATE_MS,
    START_FROM_ID: Number(env.START_FROM_ID || 0),
    TG_PREMIUM_POSTER,
    TEXT_RULES_FILE: String(env.TEXT_RULES_FILE || "").trim()
      ? path.resolve(String(env.TEXT_RULES_FILE || "").trim())
      : "",
    TMP_UPLOAD_DIR: path.resolve(".tmp-telegram-clone"),
    USE_CACHE_AS_SOURCE: /^(1|true)$/i.test(env.USE_CACHE_AS_SOURCE || "0"),
    WAIT_RANGE_DEFAULT,
    WAIT_RANGE_POST,
    WAIT_RANGE_BLOGGER,
    WAIT_RANGE_WPCOM,
    WAIT_RANGE_BSKY,
    X_ACCESS_SECRET: String(env.X_ACCESS_SECRET || "").trim(),
    X_ACCESS_TOKEN: String(env.X_ACCESS_TOKEN || "").trim(),
    X_APP_KEY: String(env.X_APP_KEY || "").trim(),
    X_APP_SECRET: String(env.X_APP_SECRET || "").trim(),
    X_WEB_HEADLESS: /^(1|true)$/i.test(env.X_WEB_HEADLESS || "0"),
    X_WEB_BROWSER_CHANNEL: String(env.X_WEB_BROWSER_CHANNEL || "chrome").trim().toLowerCase(),
    X_WEB_STEALTH: /^(1|true)$/i.test(env.X_WEB_STEALTH || "1"),
    X_WEB_LOGIN_WAIT_MS: parsePositiveIntEnv(
      env.X_WEB_LOGIN_WAIT_MS,
      300000,
      "X_WEB_LOGIN_WAIT_MS"
    ),
    X_WEB_NAV_TIMEOUT_MS: parsePositiveIntEnv(
      env.X_WEB_NAV_TIMEOUT_MS,
      60000,
      "X_WEB_NAV_TIMEOUT_MS"
    ),
    X_WEB_POST_TIMEOUT_MS: parsePositiveIntEnv(
      env.X_WEB_POST_TIMEOUT_MS,
      120000,
      "X_WEB_POST_TIMEOUT_MS"
    ),
    X_WEB_PROFILE_DIR: path.resolve(String(env.X_WEB_PROFILE_DIR || ".x-web-profile").trim()),
    X_MAX_TEXT_LENGTH,
    activeScopeRef: createActiveScopeRef(
      START_FROM_DATE,
      START_FROM_DATE_MS,
      END_AT_DATE,
      END_AT_DATE_MS
    )
  };
}

module.exports = {
  loadRuntimeConfig
};
