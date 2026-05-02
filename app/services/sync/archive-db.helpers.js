const fs = require("fs");
const path = require("path");
const {
  buildCloneMessageUpsertRecord
} = require("../../models/clone-message-record.model");
const {
  buildPostUpsertRecord,
  normalizePostIdRow
} = require("../../models/post-record.model");
const {
  buildMediaFileInsertRecord,
  normalizeMediaFileRow,
  toPositiveInt
} = require("../../models/media-file-record.model");

function createArchiveDbHelpers(deps = {}) {
  const SOURCE_CHANNEL = deps.SOURCE_CHANNEL;
  const toIsoStringSafe = deps.toIsoStringSafe;
  const buildPostTitleFromMessages = deps.buildPostTitleFromMessages;
  const getMessageMediaSizeInfo = deps.getMessageMediaSizeInfo;
  const toPosixRelativePath = deps.toPosixRelativePath;
  const storedPathToAbsolute = deps.storedPathToAbsolute;
  const fileSizeBytesSafe = deps.fileSizeBytesSafe;
  const sqlRun = deps.sqlRun;
  const sqlOne = deps.sqlOne;
  const sqlAll = deps.sqlAll;

  if (!SOURCE_CHANNEL) throw new Error("createArchiveDbHelpers: SOURCE_CHANNEL is required");
  if (typeof toIsoStringSafe !== "function") {
    throw new Error("createArchiveDbHelpers: toIsoStringSafe is required");
  }
  if (typeof buildPostTitleFromMessages !== "function") {
    throw new Error("createArchiveDbHelpers: buildPostTitleFromMessages is required");
  }
  if (typeof getMessageMediaSizeInfo !== "function") {
    throw new Error("createArchiveDbHelpers: getMessageMediaSizeInfo is required");
  }
  if (typeof toPosixRelativePath !== "function") {
    throw new Error("createArchiveDbHelpers: toPosixRelativePath is required");
  }
  if (typeof storedPathToAbsolute !== "function") {
    throw new Error("createArchiveDbHelpers: storedPathToAbsolute is required");
  }
  if (typeof fileSizeBytesSafe !== "function") {
    throw new Error("createArchiveDbHelpers: fileSizeBytesSafe is required");
  }
  if (typeof sqlRun !== "function") throw new Error("createArchiveDbHelpers: sqlRun is required");
  if (typeof sqlOne !== "function") throw new Error("createArchiveDbHelpers: sqlOne is required");
  if (typeof sqlAll !== "function") throw new Error("createArchiveDbHelpers: sqlAll is required");

  function upsertArchivedPostInDb(
    db,
    pairKey,
    messages,
    cleanedTextById,
    archiveResult,
    destinationIdsText
  ) {
    const upsertRecord = buildPostUpsertRecord({
      pairKey,
      messages,
      cleanedTextById,
      archiveResult,
      destinationIdsText,
      sourceChannel: SOURCE_CHANNEL,
      toIsoStringSafe,
      buildPostTitleFromMessages,
      toPosixRelativePath,
      nowIso: new Date().toISOString()
    });

    const dbCaptions = "";
    sqlRun(
      db,
      `INSERT INTO posts (
        pair_key, primary_source_message_id, folder_name, folder_path, post_txt_path, title,
        message_ids, message_count, media_count, media_total_size_bytes, grouped_id, original_date, original_date_end,
        edited_date, source_channel_input, has_media, views, forwards, captions, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_key, primary_source_message_id) DO UPDATE SET
        folder_name=excluded.folder_name,
        folder_path=excluded.folder_path,
        post_txt_path=excluded.post_txt_path,
        title=excluded.title,
        message_ids=excluded.message_ids,
        message_count=excluded.message_count,
        media_count=excluded.media_count,
        media_total_size_bytes=excluded.media_total_size_bytes,
        grouped_id=excluded.grouped_id,
        original_date=excluded.original_date,
        original_date_end=excluded.original_date_end,
        edited_date=excluded.edited_date,
        source_channel_input=excluded.source_channel_input,
        has_media=excluded.has_media,
        views=excluded.views,
        forwards=excluded.forwards,
        captions=excluded.captions,
        updated_at=excluded.updated_at`,
      [
        upsertRecord.pairKey,
        upsertRecord.primarySourceMessageId,
        upsertRecord.folderName,
        upsertRecord.folderPath,
        upsertRecord.postTxtPath,
        upsertRecord.title,
        upsertRecord.messageIds,
        upsertRecord.messageCount,
        upsertRecord.mediaCount,
        upsertRecord.mediaTotalSizeBytes,
        upsertRecord.groupedId,
        upsertRecord.originalDate,
        upsertRecord.originalDateEnd,
        upsertRecord.editedDate,
        upsertRecord.sourceChannelInput,
        upsertRecord.hasMedia,
        upsertRecord.views,
        upsertRecord.forwards,
        dbCaptions,
        upsertRecord.updatedAt
      ]
    );

    const postRow = sqlOne(
      db,
      "SELECT id FROM posts WHERE pair_key = ? AND primary_source_message_id = ? LIMIT 1",
      [upsertRecord.pairKey, upsertRecord.primarySourceMessageId]
    );
    const postId = normalizePostIdRow(postRow).id;
    if (!postId) {
      return;
    }

    sqlRun(db, "DELETE FROM media_files WHERE post_id = ?", [postId]);
    for (const mediaRecord of archiveResult.mediaRecords) {
      const mediaInsertRecord = buildMediaFileInsertRecord(postId, mediaRecord);
      sqlRun(
        db,
        "INSERT INTO media_files (post_id, source_message_id, relative_path, size_bytes) VALUES (?, ?, ?, ?)",
        [
          mediaInsertRecord.postId,
          mediaInsertRecord.sourceMessageId,
          mediaInsertRecord.relativePath,
          mediaInsertRecord.sizeBytes
        ]
      );
    }
  }

  function upsertCloneMessagesInDb(db, pairKey, messages, status, sourceToDestinationMap) {
    const nowIso = new Date().toISOString();
    const primary = toPositiveInt(messages[0]?.id);
    for (const message of messages) {
      const upsertRecord = buildCloneMessageUpsertRecord({
        pairKey,
        sourceMessageId: message.id,
        postPrimarySourceId: primary,
        destinationMessageId: sourceToDestinationMap.get(toPositiveInt(message.id)),
        status,
        updatedAt: nowIso
      });
      sqlRun(
        db,
        `INSERT INTO clone_messages (
          pair_key, source_message_id, post_primary_source_id, destination_message_id, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(pair_key, source_message_id) DO UPDATE SET
          post_primary_source_id=excluded.post_primary_source_id,
          destination_message_id=COALESCE(excluded.destination_message_id, clone_messages.destination_message_id),
          status=excluded.status,
          updated_at=excluded.updated_at`,
        [
          upsertRecord.pairKey,
          upsertRecord.sourceMessageId,
          upsertRecord.postPrimarySourceId,
          upsertRecord.destinationMessageId,
          upsertRecord.status,
          upsertRecord.updatedAt
        ]
      );
    }
  }

  function markCloneMessagesPostedInDb(db, pairKey, sourceIds, sourceToDestinationMap) {
    const nowIso = new Date().toISOString();
    for (const sourceIdRaw of sourceIds) {
      const srcId = toPositiveInt(sourceIdRaw);
      if (!Number.isInteger(srcId) || srcId <= 0) {
        continue;
      }
      const destinationId = toPositiveInt(sourceToDestinationMap.get(srcId)) || null;
      sqlRun(
        db,
        `UPDATE clone_messages
         SET destination_message_id = COALESCE(?, destination_message_id),
             status = 'posted',
             updated_at = ?
         WHERE pair_key = ? AND source_message_id = ?`,
        [destinationId, nowIso, pairKey, srcId]
      );
    }
  }

  function hasArchivedPostRow(db, pairKey, primarySourceMessageId) {
    const row = sqlOne(
      db,
      "SELECT 1 AS ok FROM posts WHERE pair_key = ? AND primary_source_message_id = ? LIMIT 1",
      [pairKey, primarySourceMessageId]
    );
    return !!row;
  }

  function isArchivedPostComplete(db, pairKey, messages) {
    const primarySourceMessageId = toPositiveInt(messages?.[0]?.id);
    if (!primarySourceMessageId) {
      return false;
    }
    const postRow = sqlOne(
      db,
      `SELECT id, post_txt_path
       FROM posts
       WHERE pair_key = ? AND primary_source_message_id = ?
       LIMIT 1`,
      [pairKey, primarySourceMessageId]
    );
    if (!postRow) {
      return false;
    }

    const normalizedPostRow = normalizePostIdRow(postRow);
    const postTxtAbsolutePath = storedPathToAbsolute(normalizedPostRow.postTxtPath);
    if (!postTxtAbsolutePath || !fs.existsSync(postTxtAbsolutePath)) {
      return false;
    }

    const mediaMessageIds = messages
      .filter((m) => !!m.media)
      .map((m) => toPositiveInt(m.id))
      .filter((x) => Number.isInteger(x) && x > 0);
    if (mediaMessageIds.length === 0) {
      return true;
    }
    const mediaMessageById = new Map(
      messages
        .filter((m) => !!m.media)
        .map((m) => [toPositiveInt(m.id), m])
        .filter(([id]) => Number.isInteger(id) && id > 0)
    );

    const mediaRows = sqlAll(
      db,
      "SELECT source_message_id, relative_path, size_bytes FROM media_files WHERE post_id = ?",
      [normalizedPostRow.id]
    );

    const pathsBySourceId = new Map();
    for (const row of mediaRows) {
      const mediaRow = normalizeMediaFileRow(row);
      const srcId = mediaRow.sourceMessageId;
      if (!Number.isInteger(srcId) || srcId <= 0) {
        continue;
      }
      const list = pathsBySourceId.get(srcId) || [];
      list.push({
        relativePath: mediaRow.relativePath,
        sizeBytes: mediaRow.sizeBytes
      });
      pathsBySourceId.set(srcId, list);
    }

    for (const srcId of mediaMessageIds) {
      const candidatePaths = pathsBySourceId.get(srcId) || [];
      if (candidatePaths.length === 0) {
        return false;
      }

      const message = mediaMessageById.get(srcId);
      const sizeInfo = getMessageMediaSizeInfo(message);
      const expectedSize = sizeInfo.sizeBytes;
      const hasValidFile = candidatePaths.some((entry) => {
        const absolutePath = storedPathToAbsolute(entry.relativePath);
        const actualSize = fileSizeBytesSafe(absolutePath);
        if (actualSize <= 0) {
          return false;
        }
        if (entry.sizeBytes > 0) {
          return actualSize === entry.sizeBytes;
        }
        if (expectedSize > 0 && sizeInfo.strict) {
          return actualSize === expectedSize;
        }
        return true;
      });
      if (!hasValidFile) {
        return false;
      }
    }

    return true;
  }

  function getArchivedMediaPathMapForMessages(db, pairKey, messages) {
    const result = new Map();
    const primarySourceMessageId = toPositiveInt(messages?.[0]?.id);
    if (!primarySourceMessageId) {
      return result;
    }

    const mediaMessageIds = messages
      .filter((m) => !!m.media)
      .map((m) => toPositiveInt(m.id))
      .filter((x) => Number.isInteger(x) && x > 0);
    if (mediaMessageIds.length === 0) {
      return result;
    }

    const placeholders = mediaMessageIds.map(() => "?").join(", ");
    const rows = sqlAll(
      db,
      `SELECT m.source_message_id, m.relative_path, m.size_bytes
       FROM posts p
       JOIN media_files m ON m.post_id = p.id
       WHERE p.pair_key = ?
         AND p.primary_source_message_id = ?
         AND m.source_message_id IN (${placeholders})
       ORDER BY m.id DESC`,
      [pairKey, primarySourceMessageId, ...mediaMessageIds]
    );

    const bySourceId = new Map();
    for (const row of rows) {
      const mediaRow = normalizeMediaFileRow(row);
      const srcId = mediaRow.sourceMessageId;
      if (!Number.isInteger(srcId) || srcId <= 0) {
        continue;
      }
      const list = bySourceId.get(srcId) || [];
      list.push({
        relativePath: mediaRow.relativePath,
        sizeBytes: mediaRow.sizeBytes
      });
      bySourceId.set(srcId, list);
    }

    for (const srcId of mediaMessageIds) {
      const candidates = bySourceId.get(srcId) || [];
      for (const candidate of candidates) {
        const absolutePath = storedPathToAbsolute(candidate.relativePath);
        const actualSize = fileSizeBytesSafe(absolutePath);
        if (actualSize <= 0) {
          continue;
        }
        if (candidate.sizeBytes > 0 && actualSize !== candidate.sizeBytes) {
          continue;
        }
        result.set(srcId, absolutePath);
        break;
      }
    }

    return result;
  }

  function updatePostedPostInDb(
    db,
    pairKey,
    messages,
    cleanedTextById,
    sourceToDestinationMap,
    destinationPermalink = "",
    destinationPermalinks = []
  ) {
    const primarySourceId = toPositiveInt(messages[0]?.id);
    if (!primarySourceId) return;
    const destinationIdsText = messages
      .map((m) => sourceToDestinationMap.get(toPositiveInt(m.id)))
      .filter((x) => Number.isInteger(x) && x > 0)
      .join(",");
    const permalink = String(destinationPermalink || "").trim();
    const permalinkList = Array.isArray(destinationPermalinks)
      ? Array.from(
          new Set(
            destinationPermalinks
              .map((x) => String(x || "").trim())
              .filter(Boolean)
          )
        )
      : [];
    const permalinkListJson = permalinkList.length > 0 ? JSON.stringify(permalinkList) : "";
    const nowIso = new Date().toISOString();
    sqlRun(
      db,
      `INSERT INTO post_destinations (
         pair_key,
         primary_source_message_id,
         destination_message_ids,
         destination_permalink,
         destination_permalinks,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(pair_key, primary_source_message_id) DO UPDATE SET
         destination_message_ids = excluded.destination_message_ids,
         destination_permalink = CASE
           WHEN excluded.destination_permalink != '' THEN excluded.destination_permalink
           ELSE post_destinations.destination_permalink
         END,
         destination_permalinks = CASE
           WHEN excluded.destination_permalinks != '' THEN excluded.destination_permalinks
           ELSE post_destinations.destination_permalinks
         END,
         updated_at = excluded.updated_at`,
      [
        pairKey,
        primarySourceId,
        destinationIdsText,
        permalink,
        permalinkListJson,
        nowIso
      ]
    );
  }

  return {
    getArchivedMediaPathMapForMessages,
    hasArchivedPostRow,
    isArchivedPostComplete,
    markCloneMessagesPostedInDb,
    updatePostedPostInDb,
    upsertArchivedPostInDb,
    upsertCloneMessagesInDb
  };
}

module.exports = {
  createArchiveDbHelpers
};
