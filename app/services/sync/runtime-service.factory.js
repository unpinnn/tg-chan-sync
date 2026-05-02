const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const input = require("input");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { CustomFile } = require("telegram/client/uploads");
const { TwitterApi } = require("twitter-api-v2");
const { createArchiveDbService } = require("../archive-db.service");
const {
  formatBytes,
  formatDurationShort,
  formatDurationVerbose,
  formatRunDuration,
  normalizeDate,
  sanitizeFileName,
  formatTimestampForPath,
  sanitizePathPart,
  toDateOnlyStringSafe,
  toIsoStringSafe
} = require("../format.service");
const { createTextPipeline } = require("../text-pipeline.service");
const { createTelegramClientService } = require("../telegram-client.service");
const { createXClientService } = require("../x-client.service");
const { createXWebClientService } = require("../x-web-client.service");
const { createBloggerClientService } = require("../blogger-client.service");
const { createWpComClientService } = require("../wpcom-client.service");
const { createBskyClientService } = require("../bsky-client.service");
const { createSourceCacheService } = require("../source-cache.service");
const { createMediaHelpers } = require("./media.helpers");
const { createArchiveHelpers } = require("./archive.helpers");
const { createPostHelpers } = require("./post.helpers");
const { runSyncMain } = require("./sync.runner");
const { createRuntimePacing } = require("./runtime-pacing");
const { resetActiveScopeRef } = require("../../models/sync-scope.model");
const { createTelegramTargetAdapter } = require("../targets/telegram.target");
const { createXTargetAdapter } = require("../targets/x.target");
const { createXWebTargetAdapter } = require("../targets/x-web.target");
const { createInstaTargetAdapter } = require("../targets/insta.target");
const { createBloggerTargetAdapter } = require("../targets/blogger.target");
const { createWpComTargetAdapter } = require("../targets/wpcom.target");
const { createBskyTargetAdapter } = require("../targets/bsky.target");
const { resolveTargetAdapter } = require("../targets/target-resolver.service");

function createRuntimeServiceFactory(config) {
  if (!config) {
    throw new Error("createRuntimeServiceFactory: config is required");
  }

  function guessExtensionFromMimeType(mimeType) {
    const map = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "video/mp4": ".mp4",
      "audio/mpeg": ".mp3",
      "audio/ogg": ".ogg",
      "application/pdf": ".pdf"
    };
    return map[mimeType] || "";
  }

  function extensionForMessageLocal(message) {
    const rawName = message?.file?.name || "";
    const fromName = path.extname(rawName);
    if (fromName) return fromName.toLowerCase();
    if (message.photo) return ".jpg";
    const mimeType = message?.file?.mimeType || "";
    const byMime = guessExtensionFromMimeType(mimeType);
    if (byMime) return byMime;
    if (mimeType.startsWith("image/")) return ".jpg";
    if (mimeType.startsWith("video/")) return ".mp4";
    if (mimeType.startsWith("audio/")) return ".mp3";
    return "";
  }

  function storedPathToAbsoluteLocal(storedPath) {
    const raw = String(storedPath || "").trim();
    if (!raw) return "";
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(raw.split("/").join(path.sep));
  }

  function fileSizeBytesSafeLocal(filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return 0;
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  function parseCommaSeparatedTags(value) {
    return String(value || "")
      .split(",")
      .map((x) => String(x || "").trim())
      .filter(Boolean);
  }

  function normalizeChannelHandleInput(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const fromUrl = raw.match(
      /^(?:https?:\/\/)?t(?:elegram)?\.me\/([A-Za-z0-9_]{5,})(?:\/.*)?$/i
    );
    if (fromUrl && !String(fromUrl[1] || "").startsWith("+")) {
      return String(fromUrl[1] || "").trim().replace(/^@+/, "").toLowerCase();
    }
    return raw.replace(/^@+/, "").toLowerCase();
  }

  function loadSavedSession() {
    if (process.env.TG_SESSION && process.env.TG_SESSION.trim()) {
      return process.env.TG_SESSION.trim();
    }
    return "";
  }

  const archiveDbService = createArchiveDbService({
    fs,
    archiveDir: config.ARCHIVE_DIR,
    archiveDbPath: config.ARCHIVE_DB_PATH,
    storedPathToAbsolute: storedPathToAbsoluteLocal
  });
  const {
    buildPairKey,
    getDestinationRecordByPairKey,
    getLatestDestinationRecordForSource,
    getMetaValue,
    loadPairStateFromDb,
    openArchiveDb,
    persistArchiveDb,
    resetPairPostingState,
    setMetaValue,
    sqlAll,
    sqlOne,
    sqlRun,
    upsertDestinationRecord
  } = archiveDbService;

    const pacing = createRuntimePacing({
    showProgress: config.SHOW_PROGRESS,
    heartbeatLogMs: config.HEARTBEAT_LOG_MS,
    dryRun: config.DRY_RUN,
    waitRangeDefault: config.WAIT_RANGE_DEFAULT,
    waitRangePost: config.WAIT_RANGE_POST,
    waitRangeBlogger: config.WAIT_RANGE_BLOGGER,
    waitRangeWpCom: config.WAIT_RANGE_WPCOM,
    waitRangeBsky: config.WAIT_RANGE_BSKY,
    floodBackoffGain: config.FLOOD_BACKOFF_GAIN,
    floodBackoffMaxMs: config.FLOOD_BACKOFF_MAX_MS,
    floodBackoffDecayMs: config.FLOOD_BACKOFF_DECAY_MS,
    formatDurationShort,
    formatDurationVerbose,
    getMetaValue,
    setMetaValue,
    infoTag: "[DL-INFO]"
  });
  const {
    applyPersistedCooldownBeforeRun,
    clearProgressLine,
    logInfo,
    msRangeLabel,
    renderProgressLine,
    setActiveArchiveDb,
    setInfoTag,
    sleepWithAdaptivePacing,
    withFloodWaitRetry,
    withHeartbeatLog
  } = pacing;

  const telegramClientService = createTelegramClientService({
    Api,
    CustomFile,
    TelegramClient,
    StringSession,
    input,
    apiId: config.API_ID,
    apiHash: config.API_HASH,
    gramjsLogLevel: config.GRAMJS_LOG_LEVEL,
    withFloodWaitRetry,
    getSessionString: loadSavedSession
  });
  const {
    checkDestinationWriteAccess,
    createClient,
    createDestinationChannel,
    extractChannelHandle,
    resolvePeer,
    sanitizeChannelHandle,
    usernameFromInput
  } = telegramClientService;
    const xClientService = createXClientService({
      TwitterApi,
      appKey: config.X_APP_KEY,
      appSecret: config.X_APP_SECRET,
      accessToken: config.X_ACCESS_TOKEN,
      accessSecret: config.X_ACCESS_SECRET
    });
    const bloggerClientService = createBloggerClientService({
      clientId: config.BLOGGER_CLIENT_ID,
      clientSecret: config.BLOGGER_CLIENT_SECRET,
      refreshToken: config.BLOGGER_REFRESH_TOKEN
    });
    const wpComClientService = createWpComClientService({
      clientId: config.WP_COM_CLIENT_ID,
      clientSecret: config.WP_COM_CLIENT_SECRET,
      username: config.WP_COM_USERNAME,
      appPassword: config.WP_COM_APP_PASSWORD
    });
    const bskyClientService = createBskyClientService({
      identifier: config.BSKY_IDENTIFIER,
      appPassword: config.BSKY_APP_PASSWORD,
      serviceUrl: config.BSKY_SERVICE_URL
    });

  async function start(commandState) {
    const COMMAND = String(commandState?.command || "").toLowerCase();
    const IS_SRC2LOCAL = !!commandState?.isSrc2Local;
    const IS_LOCAL2DEST = !!commandState?.isLocal2Dest;
    const IS_LOCAL_PUBLISH = !IS_SRC2LOCAL;
    const INFO_TAG = String(commandState?.infoTag || (IS_SRC2LOCAL ? "[DL-INFO]" : "[UL-INFO]"));
    setInfoTag(INFO_TAG);
    const xWebClientService = createXWebClientService({
      profileDir: config.X_WEB_PROFILE_DIR,
      headless: config.X_WEB_HEADLESS,
      browserChannel: config.X_WEB_BROWSER_CHANNEL,
      stealth: config.X_WEB_STEALTH,
      navigationTimeoutMs: config.X_WEB_NAV_TIMEOUT_MS,
      postTimeoutMs: config.X_WEB_POST_TIMEOUT_MS,
      loginWaitMs: config.X_WEB_LOGIN_WAIT_MS,
      input,
      infoTag: INFO_TAG
    });

    resetActiveScopeRef(
      config.activeScopeRef,
      config.START_FROM_DATE,
      config.START_FROM_DATE_MS,
      config.END_AT_DATE,
      config.END_AT_DATE_MS
    );

    const sourceCacheService = createSourceCacheService({
      crypto,
      destChannelInput: config.DEST_CHANNEL,
      extensionForMessage: extensionForMessageLocal,
      fileCacheEnabled: config.FILE_CACHE_ENABLED,
      fileCachePath: config.FILE_CACHE_PATH,
      fileCacheTtl: config.FILE_CACHE_TTL,
      fileSizeBytesSafe: fileSizeBytesSafeLocal,
      fs,
      isSrc2Local: IS_SRC2LOCAL,
      localArchiveDir: config.ARCHIVE_DIR,
      normalizeDate,
      sourceChannelInput: config.SOURCE_CHANNEL,
      sqlAll,
      storedPathToAbsolute: storedPathToAbsoluteLocal,
      toIsoStringSafe,
      usernameFromInput
    });

    const mediaHelpers = createMediaHelpers({
      TMP_UPLOAD_DIR: config.TMP_UPLOAD_DIR,
      MAX_GRAMJS_BUFFER_UPLOAD: config.MAX_GRAMJS_BUFFER_UPLOAD,
      DOWNLOAD_CONCURRENCY: config.DOWNLOAD_CONCURRENCY,
      HEARTBEAT_LOG_MS: config.HEARTBEAT_LOG_MS,
      SHOW_PROGRESS: config.SHOW_PROGRESS,
      PROGRESS_MIN_UPDATE_MS: config.PROGRESS_MIN_UPDATE_MS,
      sanitizeFileName,
      formatBytes,
      formatDurationShort,
      toIsoStringSafe,
      withFloodWaitRetry,
      withHeartbeatLog,
      renderProgressLine,
      clearProgressLine,
      getCachedMediaPath: sourceCacheService.getCachedMediaPath,
      saveMediaToCache: sourceCacheService.saveMediaToCache,
      logInfo
    });

    const archiveHelpers = createArchiveHelpers({
      ARCHIVE_DIR: config.ARCHIVE_DIR,
      SOURCE_CHANNEL: config.SOURCE_CHANNEL,
      HEARTBEAT_LOG_MS: config.HEARTBEAT_LOG_MS,
      formatTimestampForPath,
      sanitizePathPart,
      toIsoStringSafe,
      withHeartbeatLog,
      downloadMessageMedia: mediaHelpers.downloadMessageMedia,
      buildArchiveMediaName: mediaHelpers.buildArchiveMediaName,
      buildPostTitleFromMessages: mediaHelpers.buildPostTitleFromMessages,
      getMessageMediaSizeInfo: mediaHelpers.getMessageMediaSizeInfo,
      sqlRun,
      sqlOne,
      sqlAll
    });

    const postHelpers = createPostHelpers({
      DRY_RUN: config.DRY_RUN,
      MAX_MEDIA_CAPTION_LENGTH: config.MAX_MEDIA_CAPTION_LENGTH,
      MAX_TEXT_MESSAGE_LENGTH: config.MAX_TEXT_MESSAGE_LENGTH,
      START_FROM_ID: config.START_FROM_ID,
      END_AT_ID: config.END_AT_ID,
      START_FROM_COUNT: config.START_FROM_COUNT,
      END_AT_COUNT: config.END_AT_COUNT,
      START_FROM_DATE: config.START_FROM_DATE,
      START_FROM_DATE_MS: config.START_FROM_DATE_MS,
      END_AT_DATE: config.END_AT_DATE,
      END_AT_DATE_MS: config.END_AT_DATE_MS,
      activeScopeRef: config.activeScopeRef,
      normalizeDate,
      withFloodWaitRetry,
      downloadMessageMedia: mediaHelpers.downloadMessageMedia,
      prepareUploadFileInput: mediaHelpers.prepareUploadFileInput,
      shouldForceDocumentForReupload: mediaHelpers.shouldForceDocumentForReupload
    });

    const textPipeline = createTextPipeline({
      textRulesFile: config.TEXT_RULES_FILE,
      isSrc2Local: IS_SRC2LOCAL,
      autoPrependLine1: config.POST_AUTOPREPEND_LINE1,
      autoPrependLine2: config.POST_AUTOPREPEND_LINE2,
      autoAppendLine1: config.POST_AUTOAPPEND_LINE1,
      autoAppendLine2: config.POST_AUTOAPPEND_LINE2,
      toDateOnlyStringSafe
    });

    const local2Key = String(commandState?.local2Profile?.key || "dest").toLowerCase();
    const needsTelegramApi = IS_SRC2LOCAL || IS_LOCAL2DEST;
    if (needsTelegramApi) {
      if (!Number.isFinite(config.API_ID) || Number(config.API_ID) <= 0) {
        throw new Error("Missing required env var: TG_API_ID");
      }
      if (!String(config.API_HASH || "").trim()) {
        throw new Error("Missing required env var: TG_API_HASH");
      }
      if (IS_LOCAL2DEST && !String(config.DEST_CHANNEL || "").trim()) {
        throw new Error("Missing required env var: DEST_CHANNEL");
      }
    }
    if (local2Key === "x") {
      xClientService.assertConfigured();
    }
    if (local2Key === "blogger") {
      bloggerClientService.assertConfigured();
      if (!String(config.BLOGGER_BLOG_ID || "").trim() && !String(config.BLOGGER_BLOG_URL || "").trim()) {
        throw new Error(
          "Missing Blogger target blog locator: set BLOGGER_BLOG_ID or BLOGGER_BLOG_URL before running local2blogger."
        );
      }
    }
    if (local2Key === "wp-com") {
      wpComClientService.assertConfigured();
      if (!String(config.WP_COM_MAIN_SITE_ID || "").trim()) {
        throw new Error(
          "Missing WordPress.com target: set WP_COM_MAIN_SITE_ID before running local2wp.com."
        );
      }
    }
    if (local2Key === "bsky") {
      bskyClientService.assertConfigured();
      if (!String(config.BSKY_IDENTIFIER || "").trim()) {
        throw new Error(
          "Missing Bluesky target identifier: set BSKY_IDENTIFIER before running local2bsky."
        );
      }
    }
    let xClient = null;
    let xWebClient = null;
    let bloggerClient = null;
    let wpComClient = null;
    let bskyClient = null;
    const getXClient = () => {
      if (xClient) return xClient;
      xClient = xClientService.createClient();
      return xClient;
    };
    const getXWebClient = async () => {
      if (xWebClient) return xWebClient;
      xWebClient = await xWebClientService.createClient();
      return xWebClient;
    };
    const getBloggerClient = () => {
      if (bloggerClient) return bloggerClient;
      bloggerClient = bloggerClientService.createClient();
      return bloggerClient;
    };
    const getWpComClient = () => {
      if (wpComClient) return wpComClient;
      wpComClient = wpComClientService.createClient();
      return wpComClient;
    };
    const getBskyClient = () => {
      if (bskyClient) return bskyClient;
      bskyClient = bskyClientService.createClient();
      return bskyClient;
    };

    const localTargetId = (() => {
      if (local2Key !== "blogger") {
        if (local2Key === "wp-com") {
          return `wpcom:${String(config.WP_COM_MAIN_SITE_ID || "").trim() || "unresolved"}`;
        }
        if (local2Key === "bsky") {
          return `bsky:${String(config.BSKY_IDENTIFIER || "").trim() || "unresolved"}`;
        }
        return local2Key || "local-target";
      }
      const byId = String(config.BLOGGER_BLOG_ID || "").trim();
      if (byId) return `blogger:${byId}`;
      const byUrl = String(config.BLOGGER_BLOG_URL || "").trim().toLowerCase();
      if (byUrl) return `blogger:${byUrl}`;
      return "blogger:unresolved";
    })();

    const preferredPermalinkChannel = normalizeChannelHandleInput(
      config.APPEND_DEST_PERMALINK_CHANNEL
    );
    const getPostArchiveRow = (archiveDb, pairKey, primarySourceMessageId) => {
      const parsePairKeyIdsLocal = (rawPairKey) => {
        const text = String(rawPairKey || "");
        const idx = text.indexOf("->");
        if (idx < 0) return { sourceId: "", destinationId: "" };
        return {
          sourceId: text.slice(0, idx),
          destinationId: text.slice(idx + 2)
        };
      };
      const sourceId = Number.parseInt(String(primarySourceMessageId || 0), 10);
      if (!archiveDb || !pairKey || !Number.isInteger(sourceId) || sourceId <= 0) {
        return null;
      }
      let preferredPermalinkOverride = null;
      if (preferredPermalinkChannel) {
        const candidates = sqlAll(
          archiveDb,
          `SELECT
             pd.pair_key,
             COALESCE(pd.destination_permalink, '') AS destination_permalink,
             COALESCE(pd.destination_message_ids, '') AS destination_message_ids,
             (
               SELECT cm.destination_message_id
               FROM clone_messages cm
               WHERE cm.pair_key = pd.pair_key
                 AND cm.source_message_id = pd.primary_source_message_id
                 AND cm.destination_message_id IS NOT NULL
               LIMIT 1
             ) AS destination_message_id_fallback
           FROM post_destinations pd
           WHERE pd.primary_source_message_id = ?
           ORDER BY pd.updated_at DESC`,
          [sourceId]
        );
        for (const candidate of candidates) {
          const candidatePairKey = String(candidate?.pair_key || "").trim();
          if (!candidatePairKey) continue;
          const destinationRecord = getDestinationRecordByPairKey(archiveDb, candidatePairKey);
          const candidateUsername = String(destinationRecord?.destinationUsername || "")
            .trim()
            .replace(/^@+/, "")
            .toLowerCase();
          if (!candidateUsername || candidateUsername !== preferredPermalinkChannel) continue;
          const candidateRawPermalink = String(candidate.destination_permalink || "").trim();
          const candidateIsTelegramPermalink = /^https?:\/\/(?:t\.me|telegram\.me)\//i.test(
            candidateRawPermalink
          );
          const candidateDestinationMessageIds = String(candidate.destination_message_ids || "")
            .split(",")
            .map((x) => Number.parseInt(String(x || "").trim(), 10))
            .filter((x) => Number.isInteger(x) && x > 0);
          const candidateFallbackDestinationMessageId = Number.parseInt(
            String(candidate.destination_message_id_fallback || 0),
            10
          );
          const candidateFirstDestinationMessageId =
            candidateDestinationMessageIds[0] ||
            (Number.isInteger(candidateFallbackDestinationMessageId) &&
            candidateFallbackDestinationMessageId > 0
              ? candidateFallbackDestinationMessageId
              : 0);
          const candidateDestIdMeta = String(destinationRecord?.destinationId || "").trim();
          const candidatePairIds = parsePairKeyIdsLocal(candidatePairKey);
          const candidateRawDestinationId = String(
            candidateDestIdMeta || candidatePairIds.destinationId || ""
          ).trim();
          const candidateNormalizedDestinationId = candidateRawDestinationId.startsWith("-100")
            ? candidateRawDestinationId.slice(4)
            : candidateRawDestinationId.startsWith("-")
              ? candidateRawDestinationId.slice(1)
              : candidateRawDestinationId;
          const candidateDerivedPermalink =
            Number.isInteger(candidateFirstDestinationMessageId) &&
            candidateFirstDestinationMessageId > 0
              ? candidateUsername
                ? `https://t.me/${candidateUsername}/${candidateFirstDestinationMessageId}`
                : candidateNormalizedDestinationId
                  ? `https://t.me/c/${candidateNormalizedDestinationId}/${candidateFirstDestinationMessageId}`
                  : ""
              : "";
          preferredPermalinkOverride = {
            destinationPermalink: candidateIsTelegramPermalink ? candidateRawPermalink : "",
            destinationPermalinkDerived: candidateDerivedPermalink,
            destinationMessageIds: candidateDestinationMessageIds,
            fallbackDestinationMessageId:
              Number.isInteger(candidateFallbackDestinationMessageId) &&
              candidateFallbackDestinationMessageId > 0
                ? candidateFallbackDestinationMessageId
                : 0
          };
          break;
        }
      }
      const row = sqlOne(
        archiveDb,
        `SELECT
           p.title,
           p.post_txt_path,
           COALESCE(pd.destination_permalink, '') AS destination_permalink,
           COALESCE(pd.destination_message_ids, '') AS destination_message_ids,
           (
             SELECT cm.destination_message_id
             FROM clone_messages cm
             WHERE cm.pair_key = p.pair_key
               AND cm.source_message_id = p.primary_source_message_id
               AND cm.destination_message_id IS NOT NULL
             LIMIT 1
           ) AS destination_message_id_fallback
         FROM posts p
         LEFT JOIN post_destinations pd
           ON pd.pair_key = p.pair_key
          AND pd.primary_source_message_id = p.primary_source_message_id
         WHERE p.pair_key = ? AND p.primary_source_message_id = ?
         LIMIT 1`,
        [String(pairKey || ""), sourceId]
      );
      if (!row) return null;
      const postTxtRelPath = String(row.post_txt_path || "").trim();
      const rawPermalink = String(row.destination_permalink || "").trim();
      const isTelegramPermalink = /^https?:\/\/(?:t\.me|telegram\.me)\//i.test(rawPermalink);
      const destinationMessageIds = String(row.destination_message_ids || "")
        .split(",")
        .map((x) => Number.parseInt(String(x || "").trim(), 10))
        .filter((x) => Number.isInteger(x) && x > 0);
      const fallbackDestinationMessageId = Number.parseInt(
        String(row.destination_message_id_fallback || 0),
        10
      );
      const firstDestinationMessageId =
        destinationMessageIds[0] ||
        (Number.isInteger(fallbackDestinationMessageId) && fallbackDestinationMessageId > 0
          ? fallbackDestinationMessageId
          : 0);
      const destinationRecord = getDestinationRecordByPairKey(archiveDb, String(pairKey || ""));
      const destUsernameMeta = String(destinationRecord?.destinationUsername || "")
        .trim()
        .replace(/^@+/, "");
      const destIdMeta = String(destinationRecord?.destinationId || "").trim();
      const parsedPairIds = parsePairKeyIdsLocal(String(pairKey || ""));
      const rawDestinationId = String(destIdMeta || parsedPairIds.destinationId || "").trim();
      const normalizedDestinationId = rawDestinationId.startsWith("-100")
        ? rawDestinationId.slice(4)
        : rawDestinationId.startsWith("-")
          ? rawDestinationId.slice(1)
          : rawDestinationId;
      const derivedTelegramPermalink =
        Number.isInteger(firstDestinationMessageId) && firstDestinationMessageId > 0
          ? destUsernameMeta
            ? `https://t.me/${destUsernameMeta}/${firstDestinationMessageId}`
            : normalizedDestinationId
              ? `https://t.me/c/${normalizedDestinationId}/${firstDestinationMessageId}`
              : ""
          : "";
      return {
        title: String(row.title || "").trim(),
        destinationPermalink:
          preferredPermalinkOverride?.destinationPermalink ??
          (isTelegramPermalink ? rawPermalink : ""),
        destinationPermalinkDerived:
          preferredPermalinkOverride?.destinationPermalinkDerived ?? derivedTelegramPermalink,
        destinationMessageIds:
          preferredPermalinkOverride?.destinationMessageIds ?? destinationMessageIds,
        fallbackDestinationMessageId: Number.isInteger(
          preferredPermalinkOverride?.fallbackDestinationMessageId
        )
          ? preferredPermalinkOverride.fallbackDestinationMessageId
          : Number.isInteger(fallbackDestinationMessageId) && fallbackDestinationMessageId > 0
            ? fallbackDestinationMessageId
            : 0,
        postTxtRelPath,
        postTxtAbsPath: storedPathToAbsoluteLocal(postTxtRelPath)
      };
    };
    const closeAdditionalClients = async () => {
      if (xWebClient && typeof xWebClient.close === "function") {
        await xWebClient.close();
      }
      xWebClient = null;
      bloggerClient = null;
      wpComClient = null;
      bskyClient = null;
    };
    const targetAdapter = resolveTargetAdapter({
      targetKey: local2Key,
      adaptersByKey: {
        dest: () =>
          createTelegramTargetAdapter({
            isGroupedPost: postHelpers.isGroupedPost,
            withHeartbeatLog,
            logInfo,
            forwardMessage: postHelpers.forwardMessage,
            forwardMessageGroup: postHelpers.forwardMessageGroup,
            reuploadGroupedMedia: postHelpers.reuploadGroupedMedia,
            reuploadMessageMedia: postHelpers.reuploadMessageMedia,
            sendTextMessage: postHelpers.sendTextMessage,
            rememberMessageIdMappings: postHelpers.rememberMessageIdMappings
          }),
        x: () =>
          createXTargetAdapter({
            getXClient,
            logInfo,
            withHeartbeatLog,
            maxTextLength: config.X_MAX_TEXT_LENGTH
          }),
        "x-web": () =>
          createXWebTargetAdapter({
            getXWebClient,
            logInfo,
            withHeartbeatLog,
            maxTextLength: config.X_MAX_TEXT_LENGTH
          }),
        blogger: () =>
          createBloggerTargetAdapter({
            getBloggerClient,
            withHeartbeatLog,
            logInfo,
            sleepWithAdaptivePacing,
            blogId: config.BLOGGER_BLOG_ID,
            blogUrl: config.BLOGGER_BLOG_URL,
            blogReset: config.BLOGGER_RESET,
            blogTags: parseCommaSeparatedTags(config.BLOGGER_TAGS),
            bloggerRetryMax: config.BLOGGER_RETRY_MAX,
            bloggerRetryWaitRange: config.BLOGGER_RETRY_WAIT_RANGE,
            getPostArchiveRow
          }),
        "wp-com": () =>
          createWpComTargetAdapter({
            getWpComClient,
            withHeartbeatLog,
            sleepWithAdaptivePacing,
            logInfo,
            mainSiteId: config.WP_COM_MAIN_SITE_ID,
            mediaSiteIds: parseCommaSeparatedTags(config.WP_COM_MEDIA_SITE_IDS),
            mediaStrategy: config.WP_COM_MEDIA_STRATEGY,
            mediaFailover: config.WP_COM_MEDIA_FAILOVER,
            wpTags: parseCommaSeparatedTags(config.WP_COM_TAGS),
            wpReset: config.WP_COM_RESET,
            wpRetryMax: config.WP_COM_RETRY_MAX,
            wpRetryWaitRange: config.WP_COM_RETRY_WAIT_RANGE,
            getPostArchiveRow
          }),
        bsky: () =>
          createBskyTargetAdapter({
            getBskyClient,
            withHeartbeatLog,
            sleepWithAdaptivePacing,
            logInfo,
            getPostArchiveRow,
            bskyReset: config.BSKY_RESET,
            bskyEnableVideo: config.BSKY_ENABLE_VIDEO,
            bskyTags: parseCommaSeparatedTags(config.BSKY_TAGS),
            appendDestPermalinkTxt: config.APPEND_DEST_PERMALINK_TXT,
            bskyTextMax: config.BSKY_TEXT_MAX,
            bskyImagesMax: config.BSKY_IMAGES_MAX,
            bskyImageMaxBytes: config.BSKY_IMAGE_MAX_BYTES,
            bskyRetryMax: config.BSKY_RETRY_MAX,
            bskyRetryWaitRange: config.BSKY_RETRY_WAIT_RANGE,
            bskyPollRange: config.BSKY_POLL_RANGE
          }),
        insta: () => createInstaTargetAdapter()
      }
    });

    return runSyncMain({
      ...sourceCacheService,
      ...mediaHelpers,
      ...archiveHelpers,
      ...postHelpers,
      APPEND_DEST_PERMALINK: config.APPEND_DEST_PERMALINK,
      APPEND_DEST_PERMALINK_TXT: config.APPEND_DEST_PERMALINK_TXT,
      POST_AUTOSPLIT_TXT_HEADER_1: config.POST_AUTOSPLIT_TXT_HEADER_1,
      POST_AUTOSPLIT_TXT_FOOTER_1: config.POST_AUTOSPLIT_TXT_FOOTER_1,
      POST_AUTOSPLIT_TXT_HEADER_2: config.POST_AUTOSPLIT_TXT_HEADER_2,
      activeScopeRef: config.activeScopeRef,
      applyPersistedCooldownBeforeRun,
      applyPostAutoAppendLines:
        local2Key === "bsky"
          ? () => {}
          : textPipeline.applyPostAutoAppendLines,
      applyPostAutoPrependLines: textPipeline.applyPostAutoPrependLines,
      ARCHIVE_DB_PATH: config.ARCHIVE_DB_PATH,
      buildPairKey,
      cleanAndRewriteText: textPipeline.cleanAndRewriteText,
      COMMAND,
      checkDestinationWriteAccess,
      createClient,
      createDestinationChannel,
      DEST_CHANNEL: config.DEST_CHANNEL,
      DEST_AUTO_CREATE: config.DEST_AUTO_CREATE,
      DEST_CREATE_ABOUT: config.DEST_CREATE_ABOUT,
      DEST_CREATE_DISABLE_REACTIONS: config.DEST_CREATE_DISABLE_REACTIONS,
      DEST_CREATE_ICON: config.DEST_CREATE_ICON,
      DEST_CREATE_CHANNEL_URI_AUTO_INCREMENT: config.DEST_CREATE_CHANNEL_URI_AUTO_INCREMENT,
      DEST_CREATE_CHANNEL_URI_MAX_ATTEMPTS: config.DEST_CREATE_CHANNEL_URI_MAX_ATTEMPTS,
      DEST_CREATE_FAIL_IF_HANDLE_TAKEN: config.DEST_CREATE_FAIL_IF_HANDLE_TAKEN,
      DEST_CREATE_PUBLIC: config.DEST_CREATE_PUBLIC,
      DEST_CREATE_TITLE: config.DEST_CREATE_TITLE,
      DEST_RESET: config.DEST_RESET,
      BLOGGER_BATCH_EVERY: config.BLOGGER_BATCH_EVERY,
      BLOGGER_BATCH_PAUSE_RANGE: config.BLOGGER_BATCH_PAUSE_RANGE,
      WP_COM_BATCH_EVERY: config.WP_COM_BATCH_EVERY,
      WP_COM_BATCH_PAUSE_RANGE: config.WP_COM_BATCH_PAUSE_RANGE,
      DRY_RUN: config.DRY_RUN,
      END_AT_COUNT: config.END_AT_COUNT,
      END_AT_ID: config.END_AT_ID,
      FILE_CACHE_PATH: config.FILE_CACHE_PATH,
      FORCE_REPOST: config.FORCE_REPOST,
      formatRunDuration,
      IS_LOCAL2DEST,
      IS_LOCAL_PUBLISH,
      IS_SRC2LOCAL,
      LOCAL_TARGET_KEY: local2Key,
      LOCAL_TARGET_ID: localTargetId,
      loadPairStateFromDb,
      logInfo,
      msRangeLabel,
      openArchiveDb,
      parsePairKeyIds: sourceCacheService.parsePairKeyIds,
      persistArchiveDb,
      POST_MODE: config.POST_MODE,
      rangeLabel: postHelpers.rangeLabel,
      resolvePeer,
      resetPairPostingState,
      setMetaValue,
      upsertDestinationRecord,
      getLatestDestinationRecordForSource,
      setActiveArchiveDb,
      setActiveScopeRange: postHelpers.setActiveScopeRange,
      sleepWithAdaptivePacing,
      SOURCE_CHANNEL: config.SOURCE_CHANNEL,
      extractChannelHandle,
      sanitizeChannelHandle,
      START_FROM_COUNT: config.START_FROM_COUNT,
      START_FROM_ID: config.START_FROM_ID,
      shouldUpdateArchivePostAfterPublish: IS_LOCAL_PUBLISH,
      targetAdapter,
      TMP_UPLOAD_DIR: config.TMP_UPLOAD_DIR,
      toPosixRelativePath: archiveHelpers.toPosixRelativePath,
      usernameFromInput,
      USE_CACHE_AS_SOURCE: config.USE_CACHE_AS_SOURCE,
      WAIT_RANGE_POST: config.WAIT_RANGE_POST,
      withFloodWaitRetry,
      withHeartbeatLog,
      closeAdditionalClients,
      FLOOD_BACKOFF_GAIN: config.FLOOD_BACKOFF_GAIN,
      FLOOD_BACKOFF_MAX_MS: config.FLOOD_BACKOFF_MAX_MS
    });
  }

  return {
    start
  };
}

module.exports = {
  createRuntimeServiceFactory
};
