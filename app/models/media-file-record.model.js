"use strict";

function toPositiveInt(value) {
  const n = Number.parseInt(String(value || 0), 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function toSafeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function toSafeString(value) {
  return String(value || "");
}

function normalizeMediaFileRow(row = {}) {
  return {
    id: toPositiveInt(row.id),
    postId: toPositiveInt(row.post_id),
    primarySourceMessageId: toPositiveInt(row.primary_source_message_id),
    sourceMessageId: toPositiveInt(row.source_message_id),
    relativePath: toSafeString(row.relative_path),
    sizeBytes: Math.max(0, toSafeNumber(row.size_bytes))
  };
}

function buildMediaFileInsertRecord(postId, mediaRecord = {}) {
  return {
    postId: toPositiveInt(postId),
    sourceMessageId: toPositiveInt(mediaRecord.sourceMessageId),
    relativePath: toSafeString(mediaRecord.relativePath),
    sizeBytes: Math.max(0, toSafeNumber(mediaRecord.sizeBytes))
  };
}

module.exports = {
  buildMediaFileInsertRecord,
  normalizeMediaFileRow,
  toPositiveInt
};
