const path = require("path");

function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return "image/jpeg";
  }
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/jpeg";
}

async function persistDestinationChannelMeta(deps = {}) {
  const {
    archiveDb,
    client,
    destination,
    pairKey,
    upsertDestinationRecord,
    withFloodWaitRetry
  } = deps;
  if (
    !archiveDb ||
    !client ||
    !destination ||
    !pairKey ||
    typeof upsertDestinationRecord !== "function"
  ) {
    return;
  }

  const channelTitle = String(destination?.title || "").trim();
  const channelUsername = String(destination?.username || "").trim();
  const channelId = String(destination?.id || "").trim();
  const nowIso = new Date().toISOString();

  const persist = (iconDataUri) =>
    upsertDestinationRecord(archiveDb, {
      pairKey,
      destinationId: channelId,
      destinationTitle: channelTitle,
      destinationUsername: channelUsername,
      destinationIconDataUri: String(iconDataUri || "").trim(),
      destinationIconRelpath: "",
      updatedAt: nowIso
    });

  persist("");

  try {
    const iconBytes = await withFloodWaitRetry(
      () => client.downloadProfilePhoto(destination, { isBig: false }),
      "download destination channel icon"
    );
    if (!iconBytes || !Buffer.isBuffer(iconBytes) || iconBytes.length === 0) {
      return;
    }
    const mimeType = detectImageMimeType(iconBytes);
    const dataUri = `data:${mimeType};base64,${iconBytes.toString("base64")}`;
    persist(dataUri);
  } catch (error) {
    console.warn(`[meta] destination icon download failed: ${error?.message || error}`);
  }
}

async function bootstrapSyncRun(deps = {}) {
  const {
    applyPersistedCooldownBeforeRun,
    ARCHIVE_DB_PATH,
    buildFileCacheContext,
    buildPairKey,
    buildPeerIdResolveCandidates,
    checkDestinationWriteAccess,
    COMMAND,
    createClient,
    createDestinationChannel,
    createLinkRewriteState,
    DEST_CHANNEL,
    DEST_AUTO_CREATE,
    DEST_CREATE_ABOUT,
    DEST_CREATE_DISABLE_REACTIONS,
    DEST_CREATE_ICON,
    DEST_CREATE_CHANNEL_URI_AUTO_INCREMENT,
    DEST_CREATE_CHANNEL_URI_MAX_ATTEMPTS,
    DEST_CREATE_FAIL_IF_HANDLE_TAKEN,
    DEST_CREATE_PUBLIC,
    DEST_CREATE_TITLE,
    DRY_RUN,
    FILE_CACHE_PATH,
    findFallbackSourceCacheBundle,
    findPairKeyForLocalSource,
    FORCE_REPOST,
    IS_LOCAL2DEST,
    IS_SRC2LOCAL,
    LOCAL_TARGET_ID,
    LOCAL_TARGET_KEY,
    isFullScanManifest,
    loadCacheManifest,
    loadPairStateFromDb,
    loadScanCache,
    loadScanCacheUnchecked,
    loadSyntheticScanFromArchiveDb,
    openArchiveDb,
    parsePairKeyIds,
    peerFromCacheSnapshot,
    POST_MODE,
    resolvePeer,
    sanitizeChannelHandle,
    upsertDestinationRecord,
    setActiveArchiveDb,
    snapshotPeerForCache,
    SOURCE_CHANNEL,
    toPosixRelativePath,
    extractChannelHandle,
    usernameFromInput,
    USE_CACHE_AS_SOURCE,
    WAIT_RANGE_POST,
    msRangeLabel,
    FLOOD_BACKOFF_GAIN,
    FLOOD_BACKOFF_MAX_MS,
    withFloodWaitRetry
  } = deps;

  const archiveDb = await openArchiveDb();
  setActiveArchiveDb(archiveDb);
  const IS_LOCAL_PUBLISH = !IS_SRC2LOCAL;
  if (IS_SRC2LOCAL || IS_LOCAL2DEST) {
    await applyPersistedCooldownBeforeRun(archiveDb);
  }
  const fileCacheContext = buildFileCacheContext();
  let client = null;
  let source = null;
  let destination = null;
  let forcedPairKey = "";
  let cachedScanBundle = loadScanCache(fileCacheContext);
  let loadedScanPath = cachedScanBundle ? fileCacheContext.scanPath : "";
  let sourceCacheContextForReads = fileCacheContext;
  let archivePairKey = "";
  const forcedSourceCacheBundleRaw = loadScanCacheUnchecked({
    manifestPath: fileCacheContext.manifestPath,
    scanPath: fileCacheContext.scanPath
  });
  const forcedSourceCacheBundle =
    forcedSourceCacheBundleRaw && isFullScanManifest(forcedSourceCacheBundleRaw.manifest)
      ? forcedSourceCacheBundleRaw
      : null;
  const emergencyScanBundleRaw = loadScanCacheUnchecked({
    manifestPath: fileCacheContext.manifestPath,
    scanPath: fileCacheContext.scanPath
  });
  const emergencyScanBundle =
    emergencyScanBundleRaw && isFullScanManifest(emergencyScanBundleRaw.manifest)
      ? emergencyScanBundleRaw
      : null;
  let usingCachedScan = !!cachedScanBundle;
  let usingEmergencyCacheFallback = false;

  if (IS_LOCAL_PUBLISH) {
    if (IS_LOCAL2DEST) {
      const contentPairKey = findPairKeyForLocalSource(archiveDb);
      if (!contentPairKey) {
        throw new Error(
          `Could not find any archived posts in ${toPosixRelativePath(
            ARCHIVE_DB_PATH
          )} for SOURCE_CHANNEL="${SOURCE_CHANNEL}".`
        );
      }
      archivePairKey = contentPairKey;
      const pairIds = parsePairKeyIds(contentPairKey);
      source = {
        id: pairIds.sourceId || "",
        username: usernameFromInput(SOURCE_CHANNEL)
      };

      client = await createClient();
      console.log(
        `Connected. Command=${COMMAND} PostMode=${POST_MODE} DryRun=${DRY_RUN} ForceRepost=${FORCE_REPOST}`
      );
      if (POST_MODE === "forwarded") {
        throw new Error(
          "POST_MODE=forwarded is not supported in DB-only local2dest mode. Use POST_MODE=own-post."
        );
      }
      const createNewDestinationFromConfig = async () => {
        const resolvedHandleBase = sanitizeChannelHandle(extractChannelHandle(DEST_CHANNEL));
        const channelTitle =
          String(DEST_CREATE_TITLE || "").trim() ||
          String(source?.username || "").trim() ||
          "Channel Copy";
        const createResult = await createDestinationChannel(client, {
          title: channelTitle,
          about: String(DEST_CREATE_ABOUT || "").trim(),
          disableReactions: !!DEST_CREATE_DISABLE_REACTIONS,
          iconPath: String(DEST_CREATE_ICON || "").trim(),
          publicChannel: !!DEST_CREATE_PUBLIC,
          handleBase: resolvedHandleBase,
          handleAutoIncrement: !!DEST_CREATE_CHANNEL_URI_AUTO_INCREMENT,
          failIfHandleTaken: !!DEST_CREATE_FAIL_IF_HANDLE_TAKEN,
          maxAttempts: DEST_CREATE_CHANNEL_URI_MAX_ATTEMPTS,
          logInfo: (message) => console.log(`[dest-create] ${message}`)
        });
        const createdDestination = createResult?.channel || null;
        if (!createdDestination) {
          throw new Error("Destination channel auto-create returned no channel entity.");
        }
        if (!createdDestination.username && createResult?.assignedHandle) {
          createdDestination.username = String(createResult.assignedHandle);
        }
        console.log(
          `[dest-create] created destination channel id=${String(createdDestination.id || "")} title="${String(
            createdDestination.title || ""
          )}" access=${createResult?.createdAsPublic ? "public" : "private"}`
        );
        return createdDestination;
      };

      try {
        destination = await resolvePeer(client, DEST_CHANNEL, "destination");
        const writeAccess = await checkDestinationWriteAccess(client, destination);
        if (!writeAccess?.writable) {
          if (!DEST_AUTO_CREATE) {
            throw new Error(
              `Resolved destination is not writable by current account (${String(
                writeAccess?.reason || "unknown"
              )}).`
            );
          }
          console.warn(
            `[dest-create] resolved destination is not writable (${String(
              writeAccess?.reason || "unknown"
            )}); creating new destination channel instead.`
          );
          destination = await createNewDestinationFromConfig();
        } else {
          console.log("[dest] resolved existing destination channel with write access.");
        }
      } catch (resolveError) {
        if (!DEST_AUTO_CREATE) {
          throw resolveError;
        }
        destination = await createNewDestinationFromConfig();
      }

      forcedPairKey = buildPairKey(source, destination);
      const syntheticScan = loadSyntheticScanFromArchiveDb(archiveDb, contentPairKey);
      cachedScanBundle = {
        manifest: {
          source_peer: snapshotPeerForCache(source),
          destination_peer: snapshotPeerForCache(destination)
        },
        scan: syntheticScan
      };
      usingCachedScan = true;
      console.log(`[archive] local2dest using DB source pair ${contentPairKey}`);
      console.log(`[archive] local2dest state pair ${forcedPairKey}`);
    } else {
      const contentPairKey = findPairKeyForLocalSource(archiveDb);
      if (!contentPairKey) {
        throw new Error(
          `Could not find any archived posts in ${toPosixRelativePath(
            ARCHIVE_DB_PATH
          )} for SOURCE_CHANNEL="${SOURCE_CHANNEL}".`
        );
      }
      archivePairKey = contentPairKey;
      const pairIds = parsePairKeyIds(contentPairKey);
      source = {
        id: pairIds.sourceId || "",
        username: usernameFromInput(SOURCE_CHANNEL)
      };
      destination = {
        id: String(LOCAL_TARGET_ID || LOCAL_TARGET_KEY || "local-target"),
        username: String(LOCAL_TARGET_KEY || "")
      };
      forcedPairKey = buildPairKey(source, destination);
      const syntheticScan = loadSyntheticScanFromArchiveDb(archiveDb, contentPairKey);
      cachedScanBundle = {
        manifest: {
          source_peer: snapshotPeerForCache(source),
          destination_peer: snapshotPeerForCache(destination)
        },
        scan: syntheticScan
      };
      usingCachedScan = true;
      console.log(
        `Connected. Command=${COMMAND} PostMode=${POST_MODE} DryRun=${DRY_RUN} ForceRepost=${FORCE_REPOST} Source=archive`
      );
      console.log(`[archive] ${COMMAND} using DB source pair ${contentPairKey}`);
      console.log(`[archive] ${COMMAND} state pair ${forcedPairKey}`);
    }
  } else if (IS_SRC2LOCAL && USE_CACHE_AS_SOURCE) {
    let selectedBundle = forcedSourceCacheBundle;
    if (!selectedBundle) {
      const fallback = findFallbackSourceCacheBundle(FILE_CACHE_PATH, SOURCE_CHANNEL);
      if (fallback?.bundle) {
        selectedBundle = fallback.bundle;
        loadedScanPath = fallback.scanPath;
        sourceCacheContextForReads = {
          ...fileCacheContext,
          enabled: true,
          rootDir: fallback.scopeDir,
          manifestPath: path.join(fallback.scopeDir, "manifest.json"),
          scanPath: fallback.scanPath,
          mediaDir: path.join(fallback.scopeDir, "media")
        };
        console.warn(
          `[cache] USE_CACHE_AS_SOURCE=1 exact scope cache missing; using source-matched fallback ${toPosixRelativePath(
            fallback.scanPath
          )}`
        );
      }
    } else {
      loadedScanPath = fileCacheContext.scanPath;
      sourceCacheContextForReads = fileCacheContext;
    }
    if (!selectedBundle) {
      throw new Error(
        `USE_CACHE_AS_SOURCE=1 but cache is missing or invalid at ${toPosixRelativePath(
          fileCacheContext.scanPath
        )}.`
      );
    }
    cachedScanBundle = selectedBundle;
    usingCachedScan = true;
    source = peerFromCacheSnapshot(cachedScanBundle.manifest?.source_peer, SOURCE_CHANNEL);
    destination = peerFromCacheSnapshot(cachedScanBundle.manifest?.destination_peer, DEST_CHANNEL);
    console.log(
      `Connected. Command=${COMMAND} PostMode=${POST_MODE} DryRun=${DRY_RUN} ForceRepost=${FORCE_REPOST} Cache=forced-source`
    );
  } else if (usingCachedScan) {
    source = peerFromCacheSnapshot(cachedScanBundle.manifest?.source_peer, SOURCE_CHANNEL);
    destination = peerFromCacheSnapshot(cachedScanBundle.manifest?.destination_peer, DEST_CHANNEL);
    console.log(
      `Connected. Command=${COMMAND} PostMode=${POST_MODE} DryRun=${DRY_RUN} ForceRepost=${FORCE_REPOST} Cache=scan-hit`
    );
  } else {
    client = await createClient();
    console.log(
      `Connected. Command=${COMMAND} PostMode=${POST_MODE} DryRun=${DRY_RUN} ForceRepost=${FORCE_REPOST}`
    );
    const cacheManifest = loadCacheManifest(fileCacheContext);
    const resolveWithCachedFallback = async (peerInput, label, fallbackSnapshot) => {
      try {
        return await resolvePeer(client, peerInput, label);
      } catch (err) {
        const fallbackId = String(fallbackSnapshot?.id || "").trim();
        if (fallbackId) {
          const candidates = buildPeerIdResolveCandidates(fallbackId);
          for (const candidateId of candidates) {
            try {
              console.warn(
                `[cache] ${label} resolve failed from input; trying cached peer id ${candidateId}`
              );
              return await withFloodWaitRetry(
                () => client.getEntity(candidateId),
                `resolve ${label} from cache peer id`
              );
            } catch {
              // try next
            }
          }
        }
        const rawMessage = String(err?.errorMessage || err?.message || err || "");
        throw new Error(
          `Could not resolve ${label} "${peerInput}". ${rawMessage || ""}\n` +
            `Use a valid @username, numeric id, or invite link (https://t.me/+...).`
        );
      }
    };

    try {
      source = await resolveWithCachedFallback(
        SOURCE_CHANNEL,
        "source",
        cacheManifest?.source_peer || null
      );
      destination = await resolveWithCachedFallback(
        DEST_CHANNEL,
        "destination",
        cacheManifest?.destination_peer || null
      );
    } catch (resolveError) {
      if (IS_SRC2LOCAL && emergencyScanBundle) {
        cachedScanBundle = emergencyScanBundle;
        usingCachedScan = true;
        usingEmergencyCacheFallback = true;
        source = peerFromCacheSnapshot(cachedScanBundle.manifest?.source_peer, SOURCE_CHANNEL);
        destination = peerFromCacheSnapshot(cachedScanBundle.manifest?.destination_peer, DEST_CHANNEL);
        console.warn(
          "[cache] source/destination resolve failed; falling back to existing cached scan data."
        );
        console.warn(
          "[cache] using cached scan despite TTL/range checks to avoid aborting src2local."
        );
      } else {
        throw resolveError;
      }
    }
  }

  const linkRewriteState = createLinkRewriteState();
  const pairKey = forcedPairKey || buildPairKey(source, destination);
  if (!archivePairKey) {
    archivePairKey = pairKey;
  }

  if (IS_LOCAL2DEST && client && destination) {
    await persistDestinationChannelMeta({
      archiveDb,
      client,
      destination,
      pairKey,
      upsertDestinationRecord,
      withFloodWaitRetry
    });
  }

  const pairState = loadPairStateFromDb(archiveDb, pairKey);
  const processedSourceIds = pairState.processedSourceIds;
  for (const [srcId, dstId] of pairState.sourceToDestination.entries()) {
    linkRewriteState.sourceToDestinationId.set(srcId, dstId);
  }

  console.log(`Source: ${SOURCE_CHANNEL}`);
  if (IS_LOCAL2DEST) {
    console.log(`Destination: ${DEST_CHANNEL}`);
  } else if (IS_LOCAL_PUBLISH) {
    console.log(`Destination: ${LOCAL_TARGET_KEY || "local-target"}`);
  } else {
    console.log(`Destination: ${DEST_CHANNEL}`);
  }
  console.log(
    `Resume state: processed=${processedSourceIds.size} mapped=${linkRewriteState.sourceToDestinationId.size} db=${toPosixRelativePath(
      ARCHIVE_DB_PATH
    )}`
  );
  console.log(
    `Pacing: post=${msRangeLabel(WAIT_RANGE_POST)} flood_backoff_gain=${FLOOD_BACKOFF_GAIN} flood_backoff_max=${FLOOD_BACKOFF_MAX_MS}ms`
  );

  return {
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
  };
}

module.exports = {
  bootstrapSyncRun
};
