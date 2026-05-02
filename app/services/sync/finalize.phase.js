const fs = require("fs");
const { buildSeparatorLine } = require("../../views/log.view");
const {
  buildLocalPublishSummaryLines,
  buildSrc2LocalSummaryLines
} = require("../../views/summary.view");

async function finalizeAndExit(deps = {}) {
  const {
    activeScopeRef,
    archiveDb,
    client,
    closeAdditionalClients,
    command,
    contentMessageCount,
    copied,
    dateRangeLabel,
    DRY_RUN,
    END_AT_COUNT,
    END_AT_ID,
    formatRunDuration,
    IS_SRC2LOCAL,
    postUnits,
    prepareAddedMessages,
    prepareAddedUnits,
    prepareSkippedMessages,
    prepareSkippedUnits,
    progressMessages,
    runStartedAt,
    scanServiceSkipped,
    selectedPostUnits,
    setActiveArchiveDb,
    skipped,
    skippedExisting,
    START_FROM_COUNT,
    START_FROM_ID,
    TMP_UPLOAD_DIR,
    total,
    totalPlannedMessages,
    persistArchiveState
  } = deps;

  if (!DRY_RUN) {
    persistArchiveState();
  }

  try {
    fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (typeof closeAdditionalClients === "function") {
    await closeAdditionalClients();
  }

  if (client) {
    await client.destroy();
  }
  setActiveArchiveDb(null);
  archiveDb.close();

  const durationText = formatRunDuration(Date.now() - runStartedAt);
  const summaryFields = {
    scannedMessages: total,
    contentMessages: contentMessageCount,
    serviceMessagesSkipped: scanServiceSkipped,
    totalUnits: postUnits.length,
    selectedUnits: selectedPostUnits.length,
    selectedMessages: totalPlannedMessages,
    messageIdRange: `${START_FROM_ID}..${END_AT_ID}`,
    messageDateRange: dateRangeLabel(activeScopeRef.startDate, activeScopeRef.endDate),
    countRange: `${START_FROM_COUNT}..${END_AT_COUNT}`,
    progress: `${progressMessages}/${totalPlannedMessages}`,
    duration: durationText
  };
  console.log(buildSeparatorLine());
  if (IS_SRC2LOCAL) {
    const lines = buildSrc2LocalSummaryLines({
      ...summaryFields,
      localAddedUnits: prepareAddedUnits,
      localAddedMessages: prepareAddedMessages,
      localUpToDateUnits: prepareSkippedUnits,
      localUpToDateMessages: prepareSkippedMessages
    });
    for (const line of lines) {
      console.log(line);
    }
  } else {
    const lines = buildLocalPublishSummaryLines({
      ...summaryFields,
      mode: String(command || "local2dest").toLowerCase(),
      preparedAddedUnits: prepareAddedUnits,
      preparedAddedMessages: prepareAddedMessages,
      alreadyPostedMessages: skippedExisting,
      postedMessages: copied,
      notPostedMessages: skipped
    });
    for (const line of lines) {
      console.log(line);
    }
  }
  console.log(buildSeparatorLine());
  process.exit(0);
}

module.exports = {
  finalizeAndExit
};
