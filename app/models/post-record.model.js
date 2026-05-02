"use strict";

const path = require("path");
const { toPositiveInt } = require("./media-file-record.model");

function parseCsvPositiveInts(raw) {
  return String(raw || "")
    .split(",")
    .map((x) => toPositiveInt(String(x || "").trim()))
    .filter((x) => x > 0);
}

function normalizePostIdRow(row = {}) {
  return {
    id: toPositiveInt(row.id),
    postId: toPositiveInt(row.post_id),
    messageIds: String(row.message_ids || ""),
    destinationMessageIds: String(row.destination_message_ids || ""),
    postTxtPath: String(row.post_txt_path || ""),
    primarySourceMessageId: toPositiveInt(row.primary_source_message_id)
  };
}

function buildPostedPostMappingPairs(row = {}) {
  const normalized = normalizePostIdRow(row);
  const sourceIds = parseCsvPositiveInts(normalized.messageIds);
  const destinationIds = parseCsvPositiveInts(normalized.destinationMessageIds);
  const out = [];
  const n = Math.min(sourceIds.length, destinationIds.length);
  for (let i = 0; i < n; i += 1) {
    out.push({
      sourceMessageId: sourceIds[i],
      destinationMessageId: destinationIds[i]
    });
  }
  return out;
}

function buildPostUpsertRecord(input = {}) {
  const first = input.messages?.[0] || {};
  const last = input.messages?.[input.messages.length - 1] || first;
  const cleanedTextById = input.cleanedTextById || new Map();
  const archiveResult = input.archiveResult || { postDir: "", postTxtPath: "", mediaRecords: [] };
  const toIsoStringSafe = input.toIsoStringSafe;
  const buildPostTitleFromMessages = input.buildPostTitleFromMessages;
  const toPosixRelativePath = input.toPosixRelativePath;
  const sourceChannel = String(input.sourceChannel || "");
  const pairKey = String(input.pairKey || "");
  const destinationIdsText = String(input.destinationIdsText || "");
  const nowIso = String(input.nowIso || new Date().toISOString());

  const messageIds = (input.messages || []).map((m) => m.id).join(",");
  const mediaCount = (input.messages || []).filter((m) => !!m.media).length;
  const groupedId = first?.groupedId != null ? String(first.groupedId) : "";
  const mediaTotalSizeBytes = (archiveResult.mediaRecords || []).reduce(
    (sum, item) => sum + Math.max(0, Number(item?.sizeBytes || 0)),
    0
  );
  const title =
    typeof buildPostTitleFromMessages === "function"
      ? buildPostTitleFromMessages(input.messages || [])
      : "";
  const captions = (input.messages || [])
    .map((m) => `#${m.id}: ${cleanedTextById.get(m.id) || ""}`)
    .filter((x) => x.replace(/^#\d+:\s*/, "").trim())
    .join("\n\n");

  return {
    pairKey,
    primarySourceMessageId: toPositiveInt(first?.id),
    folderName: path.basename(String(archiveResult.postDir || "")),
    folderPath: toPosixRelativePath(archiveResult.postDir),
    postTxtPath: toPosixRelativePath(archiveResult.postTxtPath),
    title,
    messageIds,
    messageCount: (input.messages || []).length,
    mediaCount,
    mediaTotalSizeBytes,
    groupedId,
    originalDate: toIsoStringSafe(first?.date),
    originalDateEnd: toIsoStringSafe(last?.date),
    editedDate: toIsoStringSafe(first?.editDate),
    sourceChannelInput: sourceChannel,
    hasMedia: mediaCount > 0 ? 1 : 0,
    views: first?.views ?? null,
    forwards: first?.forwards ?? null,
    captions,
    destinationMessageIds: destinationIdsText,
    updatedAt: nowIso
  };
}

module.exports = {
  buildPostUpsertRecord,
  buildPostedPostMappingPairs,
  normalizePostIdRow,
  parseCsvPositiveInts
};
