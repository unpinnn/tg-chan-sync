const fs = require("fs");
const path = require("path");
const { CustomFile } = require("telegram/client/uploads");
const { createMediaProgressHelpers } = require("./media-progress.helpers");

function createMediaHelpers(deps = {}) {
  const TMP_UPLOAD_DIR = deps.TMP_UPLOAD_DIR;
  const MAX_GRAMJS_BUFFER_UPLOAD = deps.MAX_GRAMJS_BUFFER_UPLOAD;
  const DOWNLOAD_CONCURRENCY = deps.DOWNLOAD_CONCURRENCY;
  const HEARTBEAT_LOG_MS = deps.HEARTBEAT_LOG_MS;
  const SHOW_PROGRESS = deps.SHOW_PROGRESS;
  const PROGRESS_MIN_UPDATE_MS = deps.PROGRESS_MIN_UPDATE_MS;
  const sanitizeFileName = deps.sanitizeFileName;
  const formatBytes = deps.formatBytes;
  const formatDurationShort = deps.formatDurationShort;
  const toIsoStringSafe = deps.toIsoStringSafe;
  const withFloodWaitRetry = deps.withFloodWaitRetry;
  const withHeartbeatLog = deps.withHeartbeatLog;
  const renderProgressLine = deps.renderProgressLine;
  const clearProgressLine = deps.clearProgressLine;
  const getCachedMediaPath = deps.getCachedMediaPath;
  const saveMediaToCache = deps.saveMediaToCache;
  const logInfo = deps.logInfo;

  function parsePositiveInt(value) {
    const n = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
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

  function extensionForMessage(message) {
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

  function buildUploadName(message) {
    const rawName = message?.file?.name;
    if (rawName && rawName !== "unnamed") {
      return rawName;
    }

    const ext = extensionForMessage(message);
    return `message_${message.id}${ext}`;
  }

  function buildTempUploadFilePath(message) {
    const fileName = sanitizeFileName(buildUploadName(message));
    const parsed = path.parse(fileName);
    const stamp = `${Date.now()}_${message.id}`;
    const tempName = `${parsed.name}_${stamp}${parsed.ext}`;
    return path.join(TMP_UPLOAD_DIR, tempName);
  }

  function prepareUploadFileInput(message, media) {
    if (Buffer.isBuffer(media)) {
      const uploadName = sanitizeFileName(buildUploadName(message));
      if (media.length > MAX_GRAMJS_BUFFER_UPLOAD) {
        fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });
        const tempFilePath = buildTempUploadFilePath(message);
        fs.writeFileSync(tempFilePath, media);
        return { file: tempFilePath, cleanupPath: tempFilePath };
      }
      return { file: new CustomFile(uploadName, media.length, "", media), cleanupPath: "" };
    }

    if (typeof media === "string") {
      return { file: media, cleanupPath: "" };
    }

    return { file: media, cleanupPath: "" };
  }

  function shouldForceDocumentForReupload(message) {
    const mimeType = message?.file?.mimeType || "";
    if (message.photo) {
      return false;
    }
    if (mimeType.startsWith("image/")) {
      if (message.sticker || mimeType === "image/webp") {
        return true;
      }
      return false;
    }
    return true;
  }

  function detectMediaKind(message) {
    if (!message?.media) return "none";
    if (message.photo) return "image";
    if (message.sticker) return "sticker";
    if (message.video || message.videoNote || (message.file?.mimeType || "").startsWith("video/")) {
      return "video";
    }
    if (message.audio || message.voice || (message.file?.mimeType || "").startsWith("audio/")) {
      return "audio";
    }
    return "file";
  }

  function buildArchiveMediaName(message) {
    const ext = extensionForMessage(message);
    const kind = detectMediaKind(message);
    const prefixByKind = {
      image: "img",
      video: "video",
      audio: "audio",
      sticker: "sticker",
      file: "file"
    };
    const prefix = prefixByKind[kind] || "media";
    return `${prefix}${message.id}${ext}`;
  }

  function buildPostTitle(message) {
    const text = String(message?.message || "").trim();
    if (text) {
      const firstLine = text.split(/\r?\n/)[0].trim();
      if (firstLine) {
        return firstLine.slice(0, 120);
      }
    }
    const fileName = message?.file?.name;
    if (fileName && fileName !== "unnamed") {
      return fileName;
    }
    return `Post ${message?.id}`;
  }

  function buildPostTitleFromMessages(messages) {
    for (const message of messages) {
      const candidate = buildPostTitle(message);
      if (candidate && !/^Post \d+$/.test(candidate)) {
        return candidate;
      }
    }
    return buildPostTitle(messages[0]);
  }

  function getMessageMediaSizeBytes(message) {
    if (!message?.media) return 0;

    const fromFile = parsePositiveInt(message?.file?.size);
    if (fromFile > 0) return fromFile;

    const fromDocument = parsePositiveInt(message?.document?.size || message?.media?.document?.size);
    if (fromDocument > 0) return fromDocument;

    const photoSizes = message?.photo?.sizes || message?.media?.photo?.sizes || [];
    let best = 0;
    for (const size of photoSizes) {
      const n = parsePositiveInt(size?.size);
      if (n > best) best = n;
    }
    return best;
  }

  function getMessageMediaSizeInfo(message) {
    if (!message?.media) {
      return { sizeBytes: 0, strict: false };
    }

    const fromFile = parsePositiveInt(message?.file?.size);
    if (fromFile > 0) {
      return { sizeBytes: fromFile, strict: true };
    }

    const fromDocument = parsePositiveInt(message?.document?.size || message?.media?.document?.size);
    if (fromDocument > 0) {
      return { sizeBytes: fromDocument, strict: true };
    }

    const fromPhotoEstimate = getMessageMediaSizeBytes(message);
    if (fromPhotoEstimate > 0) {
      return { sizeBytes: fromPhotoEstimate, strict: false };
    }

    return { sizeBytes: 0, strict: false };
  }

  const mediaProgressHelpers = createMediaProgressHelpers({
    SHOW_PROGRESS,
    PROGRESS_MIN_UPDATE_MS,
    formatBytes,
    formatDurationShort,
    renderProgressLine,
    clearProgressLine,
    getMessageMediaSizeBytes
  });

  const createDownloadProgressTracker = mediaProgressHelpers.createDownloadProgressTracker;
  const createBatchDownloadProgressTracker = mediaProgressHelpers.createBatchDownloadProgressTracker;

  function logProcessingInfo(messages) {
    const first = messages[0];
    const title = buildPostTitleFromMessages(messages);
    const messageCount = messages.length;
    const mediaMessages = messages.filter((m) => !!m.media);
    const mediaCount = mediaMessages.length;
    let mediaTotalBytes = 0;
    let mediaSizeUnknownCount = 0;
    for (const message of mediaMessages) {
      const sizeBytes = getMessageMediaSizeBytes(message);
      if (sizeBytes > 0) {
        mediaTotalBytes += sizeBytes;
      } else {
        mediaSizeUnknownCount += 1;
      }
    }
    const originalDate = toIsoStringSafe(first?.date);
    const titleOneLine = String(title || "").replace(/\s+/g, " ").trim();
    let line =
      `processing ` +
      `title="${titleOneLine}" ` +
      `message_count=${messageCount} ` +
      `media_count=${mediaCount} `;
    if (mediaCount > 0) {
      line += `media_total_size="${formatBytes(mediaTotalBytes)} (${mediaTotalBytes} bytes)`;
      if (mediaSizeUnknownCount > 0) {
        line += `, unknown_items=${mediaSizeUnknownCount}`;
      }
      line += `" `;
    }
    line += `original_date=${originalDate}`;
    logInfo(line.trim());
  }

  async function downloadMessageMedia(client, message, options = {}) {
    if (!message?.media) {
      return undefined;
    }
    const externalProgressCallback =
      typeof options.progressCallback === "function" ? options.progressCallback : null;
    const disableInternalProgress = !!options.disableProgressTracker || !!externalProgressCallback;
    const progressTracker = disableInternalProgress ? null : createDownloadProgressTracker(message);
    try {
      const progressCallback = externalProgressCallback || progressTracker?.callback;
      return await withFloodWaitRetry(
        () =>
          client.downloadMedia(message, {
            workers: 1,
            progressCallback
          }),
        `download media #${message.id}`
      );
    } finally {
      progressTracker?.done();
    }
  }

  async function downloadMediaForMessages(client, messages, options = {}) {
    const cacheContext = options.cacheContext || null;
    const allowNetwork = options.allowNetwork !== false;
    const mediaMessages = (messages || []).filter((m) => !!m?.media);
    const downloadedMediaById = new Map();
    if (!mediaMessages.length) {
      return downloadedMediaById;
    }

    const pendingMessages = [];
    for (const message of mediaMessages) {
      const cachedPath = getCachedMediaPath(cacheContext, message);
      if (cachedPath) {
        downloadedMediaById.set(message.id, cachedPath);
        continue;
      }
      pendingMessages.push(message);
    }

    if (!pendingMessages.length) {
      return downloadedMediaById;
    }

    if (!allowNetwork || !client) {
      for (const message of pendingMessages) {
        console.warn(`[cache] missing media for #${message.id}; cannot download in cache-only mode`);
      }
      return downloadedMediaById;
    }

    const workerCount = Math.min(Math.max(1, DOWNLOAD_CONCURRENCY), pendingMessages.length);
    const batchProgress = createBatchDownloadProgressTracker(pendingMessages, workerCount);
    let cursor = 0;
    const worker = async (workerIndex) => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= pendingMessages.length) {
          return;
        }
        const message = pendingMessages[index];
        batchProgress?.start(workerIndex, message.id);
        try {
          const media = await withHeartbeatLog(
            `download_stage: downloading #${message.id}`,
            () =>
              downloadMessageMedia(client, message, {
                disableProgressTracker: true,
                progressCallback: batchProgress?.progressCallbackFor(workerIndex, message.id)
              }),
            HEARTBEAT_LOG_MS,
            { logElapsed: false }
          );
          if (media) {
            const cachedPath = saveMediaToCache(cacheContext, message, media);
            downloadedMediaById.set(message.id, cachedPath || media);
          }
        } finally {
          batchProgress?.finish(workerIndex, message.id);
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
    } finally {
      batchProgress?.done();
    }
    return downloadedMediaById;
  }

  return {
    buildArchiveMediaName,
    buildPostTitleFromMessages,
    detectMediaKind,
    downloadMediaForMessages,
    downloadMessageMedia,
    extensionForMessage,
    getMessageMediaSizeBytes,
    getMessageMediaSizeInfo,
    logProcessingInfo,
    prepareUploadFileInput,
    shouldForceDocumentForReupload
  };
}

module.exports = {
  createMediaHelpers
};
