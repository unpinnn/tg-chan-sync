const { createPreparedUnit } = require("../../models/post-unit.model");
const { buildSeparatorLine } = require("../../views/log.view");

async function runPreparePass(deps = {}) {
  const {
    applyPostAutoAppendLines,
    applyPostAutoPrependLines,
    archivePairKey,
    archiveDb,
    archivePostLocally,
    cleanAndRewriteText,
    client,
    downloadMediaForMessages,
    DRY_RUN,
    FORCE_REPOST,
    formatRunDuration,
    hasArchivedPostRow,
    isArchivedPostComplete,
    isGroupedPost,
    IS_SRC2LOCAL,
    linkRewriteState,
    logInfo,
    logProcessingInfo,
    pairKey,
    preparedUnits,
    processedSourceIds,
    selectedPostUnits,
    sourceCacheContextForReads,
    totalPlannedMessages,
    upsertArchivedPostInDb,
    upsertCloneMessagesInDb,
    persistArchiveState
  } = deps;
  const effectiveArchivePairKey = String(archivePairKey || pairKey || "");

  let skipped = Number(deps.skipped || 0);
  let skippedExisting = Number(deps.skippedExisting || 0);
  let prepareAddedUnits = Number(deps.prepareAddedUnits || 0);
  let prepareAddedMessages = Number(deps.prepareAddedMessages || 0);
  let prepareSkippedUnits = Number(deps.prepareSkippedUnits || 0);
  let prepareSkippedMessages = Number(deps.prepareSkippedMessages || 0);
  let progressMessages = Number(deps.progressMessages || 0);

  const buildCleanedTextById = (messages) => {
    const cleanedTextById = new Map();
    if (!IS_SRC2LOCAL) {
      for (const message of messages) {
        cleanedTextById.set(message.id, String(message.message || ""));
      }
      applyPostAutoPrependLines(messages, cleanedTextById);
      applyPostAutoAppendLines(messages, cleanedTextById);
      return cleanedTextById;
    }
    for (const message of messages) {
      cleanedTextById.set(message.id, cleanAndRewriteText(message.message || ""));
    }
    return cleanedTextById;
  };

  const ensureArchivedPostReady = async (messages, cleanedTextById) => {
    if (DRY_RUN) return false;
    const firstId = Number(messages[0]?.id || 0);
    const hadPostRowBefore =
      firstId > 0 && hasArchivedPostRow(archiveDb, effectiveArchivePairKey, firstId);
    if (isArchivedPostComplete(archiveDb, effectiveArchivePairKey, messages)) return false;

    if (firstId > 0 && hadPostRowBefore) {
      console.warn(`[archive] detected missing files for #${firstId}; rebuilding archive files`);
    }

    const downloadedMediaById = await downloadMediaForMessages(client, messages, {
      cacheContext: sourceCacheContextForReads,
      allowNetwork: !!client
    });
    const requiredMediaIds = messages
      .filter((m) => !!m.media)
      .map((m) => Number.parseInt(String(m.id || 0), 10))
      .filter((x) => Number.isInteger(x) && x > 0);
    if (!client && requiredMediaIds.some((id) => !downloadedMediaById.has(id))) {
      throw new Error(
        `Cache miss for one or more media files in post #${firstId}. Rebuild cache with FILE_CACHE_ENABLED=1 and a Telegram-connected src2local run.`
      );
    }

    const archiveResult = await archivePostLocally(client, messages, downloadedMediaById, cleanedTextById);
    const destinationIdsBeforeSend = messages
      .map((m) => linkRewriteState.sourceToDestinationId.get(m.id))
      .filter((x) => Number.isInteger(x) && x > 0)
      .join(",");
    upsertArchivedPostInDb(
      archiveDb,
      effectiveArchivePairKey,
      messages,
      cleanedTextById,
      archiveResult,
      destinationIdsBeforeSend
    );
    persistArchiveState();
    return true;
  };

  const preparePostUnit = async (messages) => {
    if (!messages.length) return "skipped";
    logProcessingInfo(messages);

    const sourceIds = messages
      .map((m) => Number.parseInt(String(m?.id || 0), 10))
      .filter((x) => Number.isInteger(x) && x > 0);

    try {
      const cleanedTextById = buildCleanedTextById(messages);
      if (IS_SRC2LOCAL) {
        let archiveChanged = false;
        if (DRY_RUN) {
          archiveChanged = !isArchivedPostComplete(archiveDb, effectiveArchivePairKey, messages);
        } else {
          archiveChanged = await ensureArchivedPostReady(messages, cleanedTextById);
          upsertCloneMessagesInDb(
            archiveDb,
            pairKey,
            messages,
            "archived",
            linkRewriteState.sourceToDestinationId
          );
          persistArchiveState();
        }
        if (archiveChanged) {
          preparedUnits.push(createPreparedUnit(messages));
          return "added";
        }
        skippedExisting += messages.length;
        return "skipped";
      }

      const alreadyIds = sourceIds.filter((id) => processedSourceIds.has(id));
      if (!FORCE_REPOST && alreadyIds.length > 0) {
        skippedExisting += messages.length;
        return "skipped";
      }

      if (!DRY_RUN) {
        if (!isArchivedPostComplete(archiveDb, effectiveArchivePairKey, messages)) {
          console.warn(
            `[archive] local publish missing files for #${messages[0].id}; skipping this unit (run src2local to repair).`
          );
          skipped += messages.length;
          return "skipped";
        }
        upsertCloneMessagesInDb(
          archiveDb,
          pairKey,
          messages,
          "archived",
          linkRewriteState.sourceToDestinationId
        );
        persistArchiveState();
      }
      preparedUnits.push(createPreparedUnit(messages));
      return "added";
    } catch (error) {
      skipped += messages.length;
      if (isGroupedPost(messages)) {
        console.error(
          `Failed grouped #${messages[0].id}-#${messages[messages.length - 1].id}:`,
          error?.message || error
        );
      } else {
        console.error(`Failed #${messages[0].id}:`, error?.message || error);
      }
      return "skipped";
    }
  };

  for (let i = 0; i < selectedPostUnits.length; i += 1) {
    if (i > 0) {
      console.log(buildSeparatorLine());
    }
    const unit = selectedPostUnits[i];
    const unitStartedAt = Date.now();
    const status = (await preparePostUnit(unit)) || "skipped";
    if (status === "added") {
      prepareAddedUnits += 1;
      prepareAddedMessages += unit.length;
    } else {
      prepareSkippedUnits += 1;
      prepareSkippedMessages += unit.length;
    }
    const unitDurationText = formatRunDuration(Date.now() - unitStartedAt);
    progressMessages += unit.length;
    logInfo(
      `prepare status=${status} duration=${unitDurationText} progress=${progressMessages}/${totalPlannedMessages}`
    );
  }
  console.log(`Archive pass complete. PreparedUnits=${preparedUnits.length}`);

  return {
    prepareAddedMessages,
    prepareAddedUnits,
    prepareSkippedMessages,
    prepareSkippedUnits,
    progressMessages,
    skipped,
    skippedExisting
  };
}

module.exports = {
  runPreparePass
};
