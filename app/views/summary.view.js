"use strict";

const { buildSummaryLine } = require("./log.view");

function buildBaseSummaryLines(fields = {}) {
  return [
    buildSummaryLine("scanned_messages", fields.scannedMessages),
    buildSummaryLine("content_messages", fields.contentMessages),
    buildSummaryLine("service_messages_skipped", fields.serviceMessagesSkipped),
    buildSummaryLine("total_units", fields.totalUnits),
    buildSummaryLine("selected_units", fields.selectedUnits),
    buildSummaryLine("selected_messages", fields.selectedMessages),
    buildSummaryLine("message_id_range", fields.messageIdRange),
    buildSummaryLine("message_date_range", fields.messageDateRange),
    buildSummaryLine("count_range", fields.countRange),
    buildSummaryLine("progress", fields.progress)
  ];
}

function buildSrc2LocalSummaryLines(fields = {}) {
  return [
    buildSummaryLine("mode", "src2local"),
    ...buildBaseSummaryLines(fields),
    buildSummaryLine("duration", fields.duration),
    buildSummaryLine("local_added_units", fields.localAddedUnits),
    buildSummaryLine("local_added_messages", fields.localAddedMessages),
    buildSummaryLine("local_up_to_date_units", fields.localUpToDateUnits),
    buildSummaryLine("local_up_to_date_messages", fields.localUpToDateMessages),
    buildSummaryLine("done.", "")
  ];
}

function buildLocalPublishSummaryLines(fields = {}) {
  const mode = String(fields.mode || "local2dest").trim() || "local2dest";
  return [
    buildSummaryLine("mode", mode),
    ...buildBaseSummaryLines(fields),
    buildSummaryLine("duration", fields.duration),
    buildSummaryLine("prepared_added_units", fields.preparedAddedUnits),
    buildSummaryLine("prepared_added_messages", fields.preparedAddedMessages),
    buildSummaryLine("already_posted_messages", fields.alreadyPostedMessages),
    buildSummaryLine("posted_messages", fields.postedMessages),
    buildSummaryLine("not_posted_messages", fields.notPostedMessages),
    buildSummaryLine("done.", "")
  ];
}

module.exports = {
  buildLocalPublishSummaryLines,
  buildSrc2LocalSummaryLines
};
