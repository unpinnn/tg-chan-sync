async function runPreScanAndSelection(deps = {}) {
  const {
    activeScopeRef,
    cachedScanBundle,
    client,
    contentMessageCountInitial = 0,
    dateRangeLabel,
    deserializeMessageFromCache,
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
  } = deps;

  let total = 0;
  let scanServiceSkipped = 0;
  let filteredTosPlaceholderMessages = 0;
  let contentMessageCount = Number(contentMessageCountInitial || 0);
  const postUnits = [];

  const registerPostUnit = (messages) => {
    if (!messages.length) return;
    const filteredMessages = messages.filter((message) => !isTelegramTosPlaceholderMessage(message));
    const filteredCount = messages.length - filteredMessages.length;
    if (filteredCount > 0) {
      filteredTosPlaceholderMessages += filteredCount;
    }
    if (!filteredMessages.length) return;
    contentMessageCount += filteredMessages.length;
    postUnits.push(filteredMessages);
  };

  let pendingGroupId = "";
  let pendingGroupMessages = [];

  const flushPendingGroupToUnits = async () => {
    if (pendingGroupMessages.length === 0) {
      return;
    }
    const toStore = pendingGroupMessages;
    pendingGroupMessages = [];
    pendingGroupId = "";
    registerPostUnit(toStore);
  };

  if (usingCachedScan) {
    const scan = cachedScanBundle.scan || {};
    total = Math.max(0, Number(scan.scanned_messages || 0));
    scanServiceSkipped = Math.max(0, Number(scan.service_messages_skipped || 0));
    const cachedUnits = Array.isArray(scan.post_units) ? scan.post_units : [];
    for (const cachedUnit of cachedUnits) {
      const restoredUnit = Array.isArray(cachedUnit)
        ? cachedUnit
            .map((row) => deserializeMessageFromCache(row))
            .filter((m) => Number(m?.id || 0) > 0)
        : [];
      if (restoredUnit.length > 0) {
        registerPostUnit(restoredUnit);
      }
    }
    if (total <= 0) {
      total = contentMessageCount + scanServiceSkipped;
    }
    if (IS_LOCAL_PUBLISH) {
      console.log("[archive] local publish loaded post units from archive.db");
    } else {
      console.log(
        `[cache] src2local scan loaded from ${toPosixRelativePath(
          loadedScanPath || fileCacheContext.scanPath
        )}`
      );
    }
    if (!IS_LOCAL2DEST && usingEmergencyCacheFallback) {
      console.log("[cache] emergency fallback mode active for this run.");
    }
  } else {
    for await (const message of client.iterMessages(source, { reverse: true })) {
      total += 1;
      if (message.className === "MessageService") {
        scanServiceSkipped += 1;
        continue;
      }
      if (isTelegramTosPlaceholderMessage(message)) {
        scanServiceSkipped += 1;
        continue;
      }

      const gid = groupedIdOf(message);
      if (gid) {
        if (pendingGroupId && pendingGroupId !== gid) {
          await flushPendingGroupToUnits();
        }
        pendingGroupId = gid;
        pendingGroupMessages.push(message);
      } else {
        await flushPendingGroupToUnits();
        registerPostUnit([message]);
      }
    }
    await flushPendingGroupToUnits();

    if (fileCacheContext.enabled) {
      const scanPayload = {
        scanned_messages: total,
        service_messages_skipped: scanServiceSkipped,
        post_units: postUnits.map((unit) => unit.map((message) => serializeMessageForCache(message)))
      };
      persistScanCache(fileCacheContext, {
        sourcePeer: snapshotPeerForCache(source),
        destinationPeer: snapshotPeerForCache(deps.destination),
        scan: scanPayload
      });
      console.log(`[cache] src2local scan saved to ${toPosixRelativePath(fileCacheContext.scanPath)}`);
    }
  }
  if (filteredTosPlaceholderMessages > 0) {
    scanServiceSkipped += filteredTosPlaceholderMessages;
    if (usingCachedScan) {
      console.warn(
        `[cache] filtered ${filteredTosPlaceholderMessages} Telegram ToS placeholder message(s) from cached scan`
      );
    }
  }

  const startDateResolution = resolveEffectiveStartDateFromUnits(postUnits);
  const endDateResolution = resolveEffectiveEndDateFromUnits(postUnits);
  setActiveScopeRange(
    startDateResolution.effectiveStartDate || null,
    Number(startDateResolution.effectiveStartMs || 0),
    endDateResolution.effectiveEndDate || null,
    Number(endDateResolution.effectiveEndMs || 0)
  );
  if (startDateResolution.adjusted && startDateResolution.requestedStartDate) {
    console.log(
      `[scope] START_FROM_DATE ${startDateResolution.requestedStartDate.toISOString()} not found in source dates; using nearest earlier ${activeScopeRef.startDate.toISOString()}`
    );
  }
  if (endDateResolution.adjusted && endDateResolution.requestedEndDate) {
    console.log(
      `[scope] END_AT_DATE ${endDateResolution.requestedEndDate.toISOString()} not found in source dates; using nearest later ${activeScopeRef.endDate.toISOString()}`
    );
  }

  const effectiveCountStart = START_FROM_COUNT > 0 ? START_FROM_COUNT : 1;
  const effectiveCountEnd = END_AT_COUNT > 0 ? END_AT_COUNT : postUnits.length;
  console.log(
    `Scope: message_id=${rangeLabel(START_FROM_ID, END_AT_ID)} message_date=${dateRangeLabel(
      activeScopeRef.startDate,
      activeScopeRef.endDate
    )} post_count=${rangeLabel(effectiveCountStart, effectiveCountEnd)}`
  );
  const selectedPostUnits = postUnits.filter(
    (unit, idx) => inCountRange(idx + 1) && messageUnitMatchesSourceScope(unit)
  );
  const totalPlannedMessages = selectedPostUnits.reduce((sum, unit) => sum + unit.length, 0);
  console.log(
    `Pre-scan complete. Units=${postUnits.length} SelectedUnits=${selectedPostUnits.length} Messages=${contentMessageCount} PlannedMessages=${totalPlannedMessages}`
  );

  return {
    contentMessageCount,
    postUnits,
    scanServiceSkipped,
    selectedPostUnits,
    total,
    totalPlannedMessages
  };
}

module.exports = {
  runPreScanAndSelection
};
