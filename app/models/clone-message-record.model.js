"use strict";

const { toPositiveInt } = require("./media-file-record.model");

function normalizeCloneMessageRow(row = {}) {
  return {
    sourceMessageId: toPositiveInt(row.source_message_id),
    destinationMessageId: toPositiveInt(row.destination_message_id)
  };
}

function buildCloneMessageUpsertRecord(input = {}) {
  const sourceId = toPositiveInt(input.sourceMessageId);
  const destinationId = toPositiveInt(input.destinationMessageId);
  return {
    pairKey: String(input.pairKey || ""),
    sourceMessageId: sourceId,
    postPrimarySourceId: toPositiveInt(input.postPrimarySourceId),
    destinationMessageId: destinationId > 0 ? destinationId : null,
    status: String(input.status || "archived"),
    updatedAt: String(input.updatedAt || "")
  };
}

module.exports = {
  buildCloneMessageUpsertRecord,
  normalizeCloneMessageRow
};
