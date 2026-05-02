const { runPrepareAndPosting } = require("./prepare-post.phase");
const { finalizeAndExit } = require("./finalize.phase");
const { bootstrapSyncRun } = require("./bootstrap.phase");
const { runPreScanAndSelection } = require("./scan.phase");

async function resetDestinationHistoryBeforePosting(deps = {}) {
  const {
    archiveDb,
    client,
    destination,
    DRY_RUN,
    IS_LOCAL2DEST,
    linkRewriteState,
    logInfo,
    pairKey,
    persistArchiveState,
    processedSourceIds,
    resetPairPostingState,
    withFloodWaitRetry
  } = deps;
  const shouldReset = !!deps.DEST_RESET;
  if (!IS_LOCAL2DEST || !shouldReset) {
    return;
  }
  if (DRY_RUN) {
    logInfo("dest_reset: requested but DRY_RUN=true; skipping destination wipe.");
    return;
  }

  logInfo("dest_reset: deleting all existing messages from destination...");
  let scanned = 0;
  let deleted = 0;
  let batch = [];

  const flushDeleteBatch = async () => {
    if (!batch.length) return;
    const ids = batch.slice();
    batch = [];
    await withFloodWaitRetry(
      () => client.deleteMessages(destination, ids, { revoke: true }),
      `dest reset delete ${ids[0]}-${ids[ids.length - 1]}`
    );
    deleted += ids.length;
  };

  for await (const message of client.iterMessages(destination, {})) {
    const id = Number(message?.id || 0);
    if (!Number.isInteger(id) || id <= 0) continue;
    scanned += 1;
    batch.push(id);
    if (batch.length >= 100) {
      await flushDeleteBatch();
    }
  }
  await flushDeleteBatch();

  logInfo(`dest_reset: destination scanned=${scanned} deleted=${deleted}`);
  resetPairPostingState(archiveDb, pairKey);
  persistArchiveState();
  processedSourceIds.clear();
  linkRewriteState.sourceToDestinationId.clear();
  logInfo("dest_reset: cleared posted-state mappings for current source->destination pair.");
}

async function runTargetPreflightBeforeRun(deps = {}) {
  const { IS_SRC2LOCAL, targetAdapter } = deps;
  if (IS_SRC2LOCAL) return;
  if (!targetAdapter || typeof targetAdapter.preflightBeforeRun !== "function") return;
  await targetAdapter.preflightBeforeRun(deps);
}

async function resetTargetAdapterStateBeforePosting(deps = {}) {
  const {
    archiveDb,
    DRY_RUN,
    IS_SRC2LOCAL,
    linkRewriteState,
    logInfo,
    pairKey,
    persistArchiveState,
    processedSourceIds,
    resetPairPostingState,
    targetAdapter
  } = deps;
  if (IS_SRC2LOCAL) return;
  if (!targetAdapter || typeof targetAdapter.resetBeforePosting !== "function") return;
  await targetAdapter.resetBeforePosting({
    archiveDb,
    DRY_RUN,
    linkRewriteState,
    logInfo,
    pairKey,
    persistArchiveState,
    processedSourceIds,
    resetPairPostingState
  });
}

async function runSyncMain(deps = {}) {
  const {
    APPEND_DEST_PERMALINK,
    APPEND_DEST_PERMALINK_TXT,
    POST_AUTOSPLIT_TXT_FOOTER_1,
    POST_AUTOSPLIT_TXT_HEADER_1,
    POST_AUTOSPLIT_TXT_HEADER_2,
    activeScopeRef,
    applyPostAutoAppendLines,
    applyPostAutoPrependLines,
    archivePostLocally,
    cleanAndRewriteText,
    closeAdditionalClients,
    dateRangeLabel,
    downloadMediaForMessages,
    DRY_RUN,
    DEST_RESET,
    BLOGGER_BATCH_EVERY,
    BLOGGER_BATCH_PAUSE_RANGE,
    WP_COM_BATCH_EVERY,
    WP_COM_BATCH_PAUSE_RANGE,
    END_AT_COUNT,
    END_AT_ID,
    FORCE_REPOST,
    COMMAND,
    formatRunDuration,
    forwardMessage,
    forwardMessageGroup,
    getArchivedMediaPathMapForMessages,
    groupedIdOf,
    hasArchivedPostRow,
    inCountRange,
    isArchivedPostComplete,
    isGroupedPost,
    isTelegramTosPlaceholderMessage,
    IS_LOCAL2DEST,
    IS_LOCAL_PUBLISH,
    IS_SRC2LOCAL,
    logInfo,
    logProcessingInfo,
    markCloneMessagesPostedInDb,
    messageUnitMatchesSourceScope,
    persistArchiveDb,
    POST_MODE,
    rangeLabel,
    reuploadGroupedMedia,
    reuploadMessageMedia,
    rememberMessageIdMappings,
    resolveEffectiveEndDateFromUnits,
    resolveEffectiveStartDateFromUnits,
    resetPairPostingState,
    sendTextMessage,
    serializeMessageForCache,
    setActiveArchiveDb,
    setActiveScopeRange,
    sleepWithAdaptivePacing,
    START_FROM_COUNT,
    START_FROM_ID,
    TMP_UPLOAD_DIR,
    targetAdapter,
    updatePostedPostInDb,
    upsertArchivedPostInDb,
    upsertCloneMessagesInDb,
    shouldUpdateArchivePostAfterPublish,
    withHeartbeatLog,
    withFloodWaitRetry,
    deserializeMessageFromCache,
    snapshotPeerForCache,
    persistScanCache,
    toPosixRelativePath
  } = deps;

  const runStartedAt = Date.now();

  const bootstrap = await bootstrapSyncRun({
    ...deps
  });

  const {
    archivePairKey,
    archiveDb,
    cachedScanBundle,
    client,
    destination,
    fileCacheContext,
    linkRewriteState,
    loadedScanPath,
    pairKey,
    processedSourceIds,
    source,
    sourceCacheContextForReads,
    usingCachedScan,
    usingEmergencyCacheFallback
  } = bootstrap;

  let copied = 0;
  let skipped = 0;
  let skippedExisting = 0;
  let prepareAddedUnits = 0;
  let prepareAddedMessages = 0;
  let prepareSkippedUnits = 0;
  let prepareSkippedMessages = 0;

  const persistArchiveState = () => {
    if (DRY_RUN) return;
    persistArchiveDb(archiveDb);
  };

  await resetDestinationHistoryBeforePosting({
    archiveDb,
    client,
    destination,
    DEST_RESET,
    DRY_RUN,
    IS_LOCAL2DEST,
    linkRewriteState,
    logInfo,
    pairKey,
    persistArchiveState,
    processedSourceIds,
    resetPairPostingState,
    withFloodWaitRetry
  });

  await runTargetPreflightBeforeRun({
    archiveDb,
    DRY_RUN,
    IS_SRC2LOCAL,
    linkRewriteState,
    logInfo,
    pairKey,
    persistArchiveState,
    processedSourceIds,
    resetPairPostingState,
    targetAdapter
  });

  await resetTargetAdapterStateBeforePosting({
    archiveDb,
    DRY_RUN,
    IS_SRC2LOCAL,
    linkRewriteState,
    logInfo,
    pairKey,
    persistArchiveState,
    processedSourceIds,
    resetPairPostingState,
    targetAdapter
  });

  const preScan = await runPreScanAndSelection({
    activeScopeRef,
    cachedScanBundle,
    client,
    dateRangeLabel,
    deserializeMessageFromCache,
    destination,
    END_AT_COUNT,
    END_AT_ID,
    fileCacheContext,
    groupedIdOf,
    inCountRange,
    isTelegramTosPlaceholderMessage,
    IS_LOCAL2DEST,
    IS_LOCAL_PUBLISH,
    loadedScanPath,
    messageUnitMatchesSourceScope,
    persistScanCache,
    rangeLabel,
    resolveEffectiveEndDateFromUnits,
    resolveEffectiveStartDateFromUnits,
    serializeMessageForCache,
    setActiveScopeRange,
    snapshotPeerForCache,
    source,
    START_FROM_COUNT,
    START_FROM_ID,
    toPosixRelativePath,
    usingCachedScan,
    usingEmergencyCacheFallback
  });

  const {
    contentMessageCount,
    postUnits,
    scanServiceSkipped,
    selectedPostUnits,
    total,
    totalPlannedMessages
  } = preScan;

  const preparedUnits = [];
  const phaseResult = await runPrepareAndPosting({
    applyPostAutoAppendLines,
    applyPostAutoPrependLines,
    archivePairKey,
    archiveDb,
    archivePostLocally,
    APPEND_DEST_PERMALINK,
    APPEND_DEST_PERMALINK_TXT,
    POST_AUTOSPLIT_TXT_FOOTER_1,
    POST_AUTOSPLIT_TXT_HEADER_1,
    POST_AUTOSPLIT_TXT_HEADER_2,
    cleanAndRewriteText,
    client,
    copied,
    destination,
    downloadMediaForMessages,
    DRY_RUN,
    FORCE_REPOST,
    formatRunDuration,
    forwardMessage,
    forwardMessageGroup,
    getArchivedMediaPathMapForMessages,
    hasArchivedPostRow,
    isArchivedPostComplete,
    isGroupedPost,
    IS_LOCAL2DEST,
    IS_SRC2LOCAL,
    linkRewriteState,
    logInfo,
    logProcessingInfo,
    markCloneMessagesPostedInDb,
    pairKey,
    POST_MODE,
    preparedUnits,
    prepareAddedMessages,
    prepareAddedUnits,
    prepareSkippedMessages,
    prepareSkippedUnits,
    processedSourceIds,
    progressMessages: 0,
    reuploadGroupedMedia,
    reuploadMessageMedia,
    rememberMessageIdMappings,
    selectedPostUnits,
    sendTextMessage,
    skipped,
    skippedExisting,
    sleepWithAdaptivePacing,
    source,
    sourceCacheContextForReads,
    totalPlannedMessages,
    BLOGGER_BATCH_EVERY,
    BLOGGER_BATCH_PAUSE_RANGE,
    WP_COM_BATCH_EVERY,
    WP_COM_BATCH_PAUSE_RANGE,
    updatePostedPostInDb,
    upsertArchivedPostInDb,
    upsertCloneMessagesInDb,
    shouldUpdateArchivePostAfterPublish,
    targetAdapter,
    withHeartbeatLog,
    withFloodWaitRetry,
    persistArchiveState
  });
  copied = phaseResult.copied;
  skipped = phaseResult.skipped;
  skippedExisting = phaseResult.skippedExisting;
  prepareAddedUnits = phaseResult.prepareAddedUnits;
  prepareAddedMessages = phaseResult.prepareAddedMessages;
  prepareSkippedUnits = phaseResult.prepareSkippedUnits;
  prepareSkippedMessages = phaseResult.prepareSkippedMessages;
  const progressMessages = phaseResult.progressMessages;

  await finalizeAndExit({
    command: COMMAND,
    activeScopeRef,
    archiveDb,
    client,
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
    closeAdditionalClients,
    persistArchiveState
  });
}

module.exports = {
  runSyncMain
};
