const path = require("path");
const fs = require("fs");
const {
  normalizeMediaFileRow,
  toPositiveInt
} = require("../../models/media-file-record.model");
const { parseCsvPositiveInts } = require("../../models/post-record.model");

function createSyntheticScanUtils(options = {}) {
  const normalizeDate = options.normalizeDate;
  const toIsoStringSafe = options.toIsoStringSafe;
  const fileSizeBytesSafe = options.fileSizeBytesSafe;
  const storedPathToAbsolute = options.storedPathToAbsolute;
  const sqlAll = options.sqlAll;
  const sourceChannelInput = String(options.sourceChannelInput || "");

  if (typeof normalizeDate !== "function") {
    throw new Error("createSyntheticScanUtils: normalizeDate is required");
  }
  if (typeof toIsoStringSafe !== "function") {
    throw new Error("createSyntheticScanUtils: toIsoStringSafe is required");
  }
  if (typeof fileSizeBytesSafe !== "function") {
    throw new Error("createSyntheticScanUtils: fileSizeBytesSafe is required");
  }
  if (typeof storedPathToAbsolute !== "function") {
    throw new Error("createSyntheticScanUtils: storedPathToAbsolute is required");
  }
  if (typeof sqlAll !== "function") {
    throw new Error("createSyntheticScanUtils: sqlAll is required");
  }

  function parsePairKeyIds(pairKey) {
    const text = String(pairKey || "");
    const [sourceIdRaw, destinationIdRaw] = text.split("->");
    return {
      sourceId: String(sourceIdRaw || "").trim(),
      destinationId: String(destinationIdRaw || "").trim()
    };
  }

  function parseCaptionMap(captionsText) {
    const text = String(captionsText || "");
    const out = new Map();
    if (!text.trim()) {
      return out;
    }
    const re = /#(\d+):\s*/g;
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({
        id: Number.parseInt(String(m[1] || 0), 10),
        bodyStart: re.lastIndex,
        markerStart: m.index
      });
    }
    for (let i = 0; i < matches.length; i += 1) {
      const current = matches[i];
      if (!Number.isInteger(current.id) || current.id <= 0) {
        continue;
      }
      const next = matches[i + 1];
      const end = next ? next.markerStart : text.length;
      const body = text.slice(current.bodyStart, end).trim();
      out.set(current.id, body);
    }
    return out;
  }

  function parseCaptionMapFromPostTxt(postTxtPath) {
    const absolutePath = storedPathToAbsolute(postTxtPath);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      return new Map();
    }
    const raw = String(fs.readFileSync(absolutePath, "utf8") || "");
    const marker = /\bcaptions:\s*/i.exec(raw);
    const captionsSection = marker ? raw.slice(marker.index + marker[0].length) : raw;
    return parseCaptionMap(captionsSection);
  }

  function mimeTypeFromPath(filePath) {
    const ext = String(path.extname(String(filePath || "")).toLowerCase());
    const byExt = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".mkv": "video/x-matroska",
      ".mov": "video/quicktime",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".wav": "audio/wav",
      ".pdf": "application/pdf"
    };
    return byExt[ext] || "application/octet-stream";
  }

  function pickMediaKindFromPath(filePath) {
    const name = path.basename(String(filePath || "")).toLowerCase();
    if (name.startsWith("img")) return "image";
    if (name.startsWith("video")) return "video";
    if (name.startsWith("audio")) return "audio";
    if (name.startsWith("sticker")) return "sticker";
    const mime = mimeTypeFromPath(filePath);
    if (mime.startsWith("image/")) return mime === "image/webp" ? "sticker" : "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "file";
  }

  function buildSyntheticMessagesFromPostRow(postRow, mediaRowsBySourceId) {
    const sourceIds = parseCsvPositiveInts(postRow?.message_ids);
    const captionMapFromFile = parseCaptionMapFromPostTxt(postRow?.post_txt_path);
    const captionMapFromDb = parseCaptionMap(postRow?.captions);
    const groupedIdRaw = String(postRow?.grouped_id || "").trim();
    const groupedId = groupedIdRaw || undefined;
    const baseDate = normalizeDate(postRow?.original_date);
    const validBaseDate = Number.isNaN(baseDate.getTime()) ? new Date() : baseDate;

    return sourceIds.map((sourceId, idx) => {
      const mediaEntries = mediaRowsBySourceId.get(sourceId) || [];
      const mediaEntry = mediaEntries[0] || null;
      const hasMedia = !!mediaEntry;
      const mediaPathAbs = mediaEntry ? storedPathToAbsolute(mediaEntry.relativePath) : "";
      const mimeType = hasMedia ? mimeTypeFromPath(mediaPathAbs || mediaEntry.relativePath) : "";
      const mediaKind = hasMedia ? pickMediaKindFromPath(mediaPathAbs || mediaEntry.relativePath) : "none";
      const sizeBytes = hasMedia
        ? Math.max(
            0,
            Number(mediaEntry.sizeBytes || 0),
            fileSizeBytesSafe(mediaPathAbs || mediaEntry.relativePath)
          )
        : 0;
      const fileName = hasMedia ? path.basename(mediaPathAbs || mediaEntry.relativePath) : "";
      const date = new Date(validBaseDate.getTime() + idx * 1000);
      const messageText = captionMapFromFile.has(sourceId)
        ? String(captionMapFromFile.get(sourceId) || "")
        : captionMapFromDb.has(sourceId)
          ? String(captionMapFromDb.get(sourceId) || "")
          : "";

      const message = {
        id: sourceId,
        message: messageText,
        date,
        editDate: undefined,
        views: postRow?.views ?? null,
        forwards: postRow?.forwards ?? null,
        groupedId,
        className: "Message",
        media: hasMedia ? {} : null,
        file: {
          name: fileName || "",
          size: sizeBytes,
          mimeType: mimeType || ""
        },
        photo: mediaKind === "image" ? { sizes: sizeBytes > 0 ? [{ size: sizeBytes }] : [] } : undefined,
        sticker: mediaKind === "sticker",
        video: mediaKind === "video",
        videoNote: false,
        audio: mediaKind === "audio",
        voice: false,
        entities: undefined
      };
      if (hasMedia && sizeBytes > 0) {
        message.document = { size: sizeBytes };
        message.media.document = { size: sizeBytes };
      }
      if (hasMedia && message.photo) {
        message.media.photo = message.photo;
      }
      return message;
    });
  }

  function isTelegramTosPlaceholderText(text) {
    const normalized = String(text || "").trim();
    if (!normalized) {
      return false;
    }
    return (
      /could(?:n't| not)\s+be\s+displayed.*telegram.*terms\s+of\s+service/i.test(normalized) ||
      /violates?\s+the\s+telegram\s+terms\s+of\s+service/i.test(normalized)
    );
  }

  function isTelegramTosPlaceholderMessage(message) {
    if (!message || message.className === "MessageService" || message.media) {
      return false;
    }
    if (isTelegramTosPlaceholderText(message.message || "")) {
      return true;
    }
    const reasons = Array.isArray(message?.restrictionReason)
      ? message.restrictionReason
      : Array.isArray(message?.restriction_reason)
        ? message.restriction_reason
        : [];
    return reasons.some((reason) =>
      /terms?\s+of\s+service|tos/i.test(String(reason?.reason || reason || ""))
    );
  }

  function serializeMessageForCache(message) {
    const photoSizes = message?.photo?.sizes || message?.media?.photo?.sizes || [];
    const serializedSizes = Array.isArray(photoSizes)
      ? photoSizes.map((x) => Number.parseInt(String(x?.size || 0), 10)).filter((x) => x > 0)
      : [];
    return {
      id: Number(message?.id || 0),
      message: String(message?.message || ""),
      date: toIsoStringSafe(message?.date),
      editDate: toIsoStringSafe(message?.editDate),
      views: message?.views ?? null,
      forwards: message?.forwards ?? null,
      groupedId: message?.groupedId == null ? "" : String(message.groupedId),
      className: String(message?.className || "Message"),
      media: !!message?.media,
      file: {
        name: String(message?.file?.name || ""),
        size: toPositiveInt(message?.file?.size),
        mimeType: String(message?.file?.mimeType || "")
      },
      flags: {
        photo: !!message?.photo,
        sticker: !!message?.sticker,
        video: !!message?.video,
        videoNote: !!message?.videoNote,
        audio: !!message?.audio,
        voice: !!message?.voice
      },
      documentSize: toPositiveInt(message?.document?.size || message?.media?.document?.size),
      photoSizes: serializedSizes
    };
  }

  function deserializeMessageFromCache(record) {
    const hasMedia = !!record?.media;
    const documentSize = toPositiveInt(record?.documentSize);
    const photoSizes = Array.isArray(record?.photoSizes)
      ? record.photoSizes
          .map((x) => Number.parseInt(String(x || 0), 10))
          .filter((x) => Number.isInteger(x) && x > 0)
      : [];

    const message = {
      id: Number(record?.id || 0),
      message: String(record?.message || ""),
      date: record?.date ? new Date(record.date) : undefined,
      editDate: record?.editDate ? new Date(record.editDate) : undefined,
      views: record?.views ?? null,
      forwards: record?.forwards ?? null,
      groupedId: record?.groupedId ? String(record.groupedId) : undefined,
      className: String(record?.className || "Message"),
      media: hasMedia ? {} : null,
      file: {
        name: String(record?.file?.name || ""),
        size: toPositiveInt(record?.file?.size),
        mimeType: String(record?.file?.mimeType || "")
      },
      photo: record?.flags?.photo ? { sizes: photoSizes.map((size) => ({ size })) } : undefined,
      sticker: !!record?.flags?.sticker,
      video: !!record?.flags?.video,
      videoNote: !!record?.flags?.videoNote,
      audio: !!record?.flags?.audio,
      voice: !!record?.flags?.voice
    };

    if (hasMedia && documentSize > 0) {
      message.document = { size: documentSize };
      message.media.document = { size: documentSize };
    }
    if (hasMedia && message.photo) {
      message.media.photo = message.photo;
    }
    return message;
  }

  function loadSyntheticScanFromArchiveDb(db, pairKey) {
    const postRows = sqlAll(
      db,
      `SELECT id, primary_source_message_id, message_ids, captions, grouped_id, original_date,
              original_date_end, edited_date, views, forwards, post_txt_path
       FROM posts
       WHERE pair_key = ?
       ORDER BY primary_source_message_id ASC`,
      [pairKey]
    );

    const mediaRows = sqlAll(
      db,
      `SELECT p.primary_source_message_id, m.source_message_id, m.relative_path, m.size_bytes
       FROM posts p
       JOIN media_files m ON m.post_id = p.id
       WHERE p.pair_key = ?
       ORDER BY p.primary_source_message_id ASC, m.id ASC`,
      [pairKey]
    );

    const mediaByPrimary = new Map();
    for (const row of mediaRows) {
      const mediaRow = normalizeMediaFileRow(row);
      const primaryId = mediaRow.primarySourceMessageId;
      const sourceId = mediaRow.sourceMessageId;
      if (
        !Number.isInteger(primaryId) ||
        primaryId <= 0 ||
        !Number.isInteger(sourceId) ||
        sourceId <= 0
      ) {
        continue;
      }
      const bySource = mediaByPrimary.get(primaryId) || new Map();
      const list = bySource.get(sourceId) || [];
      list.push(mediaRow);
      bySource.set(sourceId, list);
      mediaByPrimary.set(primaryId, bySource);
    }

    const postUnits = [];
    let allContentMessages = 0;
    for (const postRow of postRows) {
      const primaryId = toPositiveInt(postRow.primary_source_message_id);
      const mediaBySource = mediaByPrimary.get(primaryId) || new Map();
      const messages = buildSyntheticMessagesFromPostRow(postRow, mediaBySource);
      allContentMessages += messages.length;
      if (!messages.length) {
        continue;
      }
      postUnits.push(messages.map((m) => serializeMessageForCache(m)));
    }

    return {
      scanned_messages: allContentMessages,
      service_messages_skipped: 0,
      post_units: postUnits
    };
  }

  function findPairKeyForLocalSource(db) {
    const rows = sqlAll(
      db,
      `SELECT pair_key, COUNT(*) AS post_count, MAX(updated_at) AS last_updated
       FROM posts
       WHERE LOWER(COALESCE(source_channel_input, '')) = LOWER(?)
       GROUP BY pair_key
       ORDER BY post_count DESC, last_updated DESC`,
      [sourceChannelInput]
    );
    const fallbackRows =
      rows.length > 0
        ? rows
        : sqlAll(
            db,
            `SELECT pair_key, COUNT(*) AS post_count, MAX(updated_at) AS last_updated
             FROM posts
             GROUP BY pair_key
             ORDER BY post_count DESC, last_updated DESC`
          );
    if (fallbackRows.length === 0) {
      return "";
    }
    return String(fallbackRows[0].pair_key || "");
  }

  return {
    deserializeMessageFromCache,
    findPairKeyForLocalSource,
    isTelegramTosPlaceholderMessage,
    loadSyntheticScanFromArchiveDb,
    parsePairKeyIds,
    serializeMessageForCache
  };
}

module.exports = {
  createSyntheticScanUtils
};
