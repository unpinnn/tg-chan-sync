const { countPreparedUnitMessages } = require("../../models/post-unit.model");
const { buildSeparatorLine } = require("../../views/log.view");
const { assertValidTargetAdapter } = require("../targets/target.interface");

function normalizeTelegramUsername(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

function normalizeTelegramChannelIdForC(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("-100")) return raw.slice(4);
  if (raw.startsWith("-")) return raw.slice(1);
  return raw;
}

function buildTelegramPermalinkAuto(destination, destinationMessageId) {
  const dstId = Number(destinationMessageId || 0);
  if (!Number.isInteger(dstId) || dstId <= 0) return "";
  const username = normalizeTelegramUsername(destination?.username);
  if (username) return `https://t.me/${username}/${dstId}`;
  const channelId = normalizeTelegramChannelIdForC(destination?.id);
  if (!channelId) return "";
  return `https://t.me/c/${channelId}/${dstId}`;
}

function appendPermalinkOnce(text, permalink, permalinkPrefix = "") {
  const base = String(text || "");
  const link = String(permalink || "").trim();
  const prefix = String(permalinkPrefix || "");
  if (!link) return base;
  if (base.includes(link)) return base;
  const permalinkText = prefix
    ? `${prefix}${/\s$/.test(prefix) ? "" : " "}${link}`
    : link;
  return base.trim() ? `${base}\n\n${permalinkText}` : permalinkText;
}

function clampText(value, maxLen) {
  const text = String(value || "");
  const limit = Number(maxLen || 0);
  if (!Number.isInteger(limit) || limit <= 0) return text;
  if (text.length <= limit) return text;
  return text.slice(0, limit).trimEnd();
}

function isMediaCaptionTooLongError(error) {
  const msg = String(error?.message || error || "");
  return /MEDIA_CAPTION_TOO_LONG/i.test(msg);
}

function normalizeOutgoingPartText(value) {
  const text = String(value || "");
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function preferredSplitIndex(value, maxLen, minRatio = 0.6) {
  const text = String(value || "");
  const limit = Math.max(1, Number(maxLen || 0));
  if (text.length <= limit) return text.length;
  const minLen = Math.max(1, Math.floor(limit * Math.max(0, Math.min(1, Number(minRatio || 0)))));
  const probes = ["\n\n", "\n", " "];
  for (const probe of probes) {
    const idx = text.lastIndexOf(probe, limit);
    if (idx >= minLen) return probe === " " ? idx : idx + probe.length;
  }
  return limit;
}

function moveCutOutsideUrl(text, cut, minLen = 1) {
  const value = String(text || "");
  let target = Number(cut || 0);
  if (!Number.isInteger(target) || target <= 0) return 1;
  if (target >= value.length) return Math.max(1, value.length - 1);
  const min = Math.max(1, Number(minLen || 1));
  const urlPattern = /https?:\/\/[^\s<>"'`]+/gi;
  let match = null;
  while ((match = urlPattern.exec(value))) {
    const start = match.index;
    const end = start + String(match[0] || "").length;
    if (target > start && target < end) {
      if (start >= min) return start;
      if (end < value.length) return end;
      return Math.max(min, Math.min(value.length - 1, start));
    }
  }
  return target;
}

function isWordChar(value) {
  return /[\p{L}\p{N}]/u.test(String(value || ""));
}

function moveCutToWordBoundary(text, cut, minLen = 1) {
  const value = String(text || "");
  let target = Number(cut || 0);
  if (!Number.isInteger(target) || target <= 0) return 1;
  if (target >= value.length) return Math.max(1, value.length - 1);
  const min = Math.max(1, Number(minLen || 1));
  while (
    target > min &&
    target < value.length &&
    isWordChar(value[target - 1]) &&
    isWordChar(value[target])
  ) {
    target -= 1;
  }
  return Math.max(min, Math.min(value.length - 1, target));
}

function moveCutToSentenceStart(text, cut, minLen = 1) {
  const value = String(text || "");
  const target = Number(cut || 0);
  if (!Number.isInteger(target) || target <= 0) return 1;
  if (target >= value.length) return Math.max(1, value.length - 1);
  const min = Math.max(1, Number(minLen || 1));
  const left = value.slice(0, target);
  const boundaryPattern = /(?:[.!?؟؛]\s+|\n{2,})/gu;
  let match = null;
  let candidate = -1;
  while ((match = boundaryPattern.exec(left))) {
    const nextStart = match.index + String(match[0] || "").length;
    if (nextStart >= min && nextStart < target) {
      candidate = nextStart;
    }
  }
  if (candidate >= min) {
    return candidate;
  }
  return target;
}

function makeReadableSplitCut(text, cut, minLen = 1) {
  return getReadableSplitCutInfo(text, cut, minLen).cut;
}

function getReadableSplitCutInfo(text, cut, minLen = 1) {
  const value = String(text || "");
  if (value.length <= 1) return { cut: 1, mode: "raw-boundary" };
  const base = Math.max(1, Math.min(value.length - 1, Number(cut || 1)));
  const afterUrl = moveCutOutsideUrl(value, base, minLen);
  const afterSentence = moveCutToSentenceStart(value, afterUrl, minLen);
  const afterWord = moveCutToWordBoundary(value, afterSentence, minLen);
  const finalCut = Math.max(1, Math.min(value.length - 1, afterWord));

  let mode = "raw-boundary";
  if (afterSentence !== afterUrl) {
    mode = "sentence-boundary";
  } else if (afterWord !== afterSentence) {
    mode = "word-boundary";
  } else if (afterUrl !== base) {
    mode = "url-boundary";
  }
  return { cut: finalCut, mode };
}

async function runPostingPass(deps = {}) {
  const {
    APPEND_DEST_PERMALINK,
    APPEND_DEST_PERMALINK_TXT = "",
    applyPostAutoAppendLines = () => {},
    applyPostAutoPrependLines = () => {},
    archivePairKey,
    archiveDb,
    cleanAndRewriteText,
    client,
    destination,
    DRY_RUN,
    formatRunDuration,
    getArchivedMediaPathMapForMessages,
    isGroupedPost,
    IS_SRC2LOCAL,
    linkRewriteState,
    logInfo,
    logProcessingInfo,
    MAX_MEDIA_CAPTION_LENGTH = 1024,
    MAX_TEXT_MESSAGE_LENGTH = 4096,
    POST_AUTOSPLIT_TXT_FOOTER_1 = "",
    POST_AUTOSPLIT_TXT_HEADER_1 = "1/2",
    POST_AUTOSPLIT_TXT_HEADER_2 = "2/2",
    markCloneMessagesPostedInDb,
    pairKey,
    POST_MODE,
    preparedUnits,
    processedSourceIds,
    sleepWithAdaptivePacing,
    source,
    targetAdapter,
    BLOGGER_BATCH_EVERY = 0,
    BLOGGER_BATCH_PAUSE_RANGE = { min: 0, max: 0 },
    WP_COM_BATCH_EVERY = 0,
    WP_COM_BATCH_PAUSE_RANGE = { min: 0, max: 0 },
    shouldUpdateArchivePostAfterPublish,
    updatePostedPostInDb,
    withFloodWaitRetry,
    persistArchiveState
  } = deps;
  const effectiveArchivePairKey = String(archivePairKey || pairKey || "");
  const shouldUpdateArchivePost = shouldUpdateArchivePostAfterPublish !== false;

  let copied = Number(deps.copied || 0);
  let skipped = Number(deps.skipped || 0);

  if (!IS_SRC2LOCAL) {
    assertValidTargetAdapter(targetAdapter);
    targetAdapter.assertPostMode(POST_MODE);
  }

  const postPreparedUnit = async (messages) => {
    if (!messages.length) return "skipped";
    try {
      const downloadedMediaById = new Map();
      const needsMediaForReupload = POST_MODE === "own-post" && messages.some((m) => !!m.media);
      if (needsMediaForReupload) {
        if (!DRY_RUN) {
          const archivedMediaById = getArchivedMediaPathMapForMessages(
            archiveDb,
            effectiveArchivePairKey,
            messages
          );
          for (const [sourceId, mediaPath] of archivedMediaById.entries()) {
            downloadedMediaById.set(sourceId, mediaPath);
          }
        }
        const missingMediaMessages = messages.filter((m) => !!m.media && !downloadedMediaById.has(m.id));
        if (missingMediaMessages.length > 0) {
          console.warn(
            `[archive] local publish missing archived media for ${missingMediaMessages.length} item(s) in unit #${messages[0].id}; skipping this unit.`
          );
          skipped += messages.length;
          return "skipped";
        }
      }

      let sentCount = 0;
      let mappingChanged = 0;
      const sentSourceIds = [];
      let destinationPermalinkList = [];
      const cleanedTextById = new Map();
      const rawTextById = new Map();
      for (const message of messages) {
        const rawText = !IS_SRC2LOCAL
          ? String(message.message || "")
          : cleanAndRewriteText(message.message || "");
        rawTextById.set(message.id, rawText);
        cleanedTextById.set(message.id, rawText);
      }
      applyPostAutoPrependLines(messages, cleanedTextById);
      applyPostAutoAppendLines(messages, cleanedTextById);
      if (targetAdapter?.key === "dest") {
        for (const message of messages) {
          const id = Number(message?.id || 0);
          if (!Number.isInteger(id) || id <= 0) continue;
          cleanedTextById.set(id, normalizeOutgoingPartText(cleanedTextById.get(id) || ""));
        }
      }
      const postResult = await targetAdapter.postMessages({
        archiveDb,
        archivePairKey: effectiveArchivePairKey,
        cleanedTextById,
        client,
        destination,
        downloadedMediaById,
        linkRewriteState,
        messages,
        postMode: POST_MODE,
        source,
        suppressPrimaryOverflowText:
          !!APPEND_DEST_PERMALINK && targetAdapter?.key === "dest"
      });
      const primaryDestinationPermalink = String(
        postResult?.primaryDestinationPermalink || ""
      ).trim();
      if (primaryDestinationPermalink) {
        destinationPermalinkList.push(primaryDestinationPermalink);
      }
      sentCount = Number(postResult?.sentCount || 0);
      mappingChanged = Number(postResult?.mappingChanged || 0);
      const resultSourceIds = Array.isArray(postResult?.sentSourceIds) ? postResult.sentSourceIds : [];
      for (const sourceId of resultSourceIds) {
        const id = Number(sourceId || 0);
        if (Number.isInteger(id) && id > 0) {
          sentSourceIds.push(id);
        }
      }

      if (!DRY_RUN && targetAdapter?.key === "dest" && sentSourceIds.length > 0) {
        const primarySourceId = Number(messages[0]?.id || 0);
        const primaryDestinationId = linkRewriteState.sourceToDestinationId.get(primarySourceId);
        const rawPrimaryText = String(rawTextById.get(primarySourceId) || "").trim();
        if (
          Number.isInteger(primarySourceId) &&
          primarySourceId > 0 &&
          Number.isInteger(primaryDestinationId) &&
          primaryDestinationId > 0 &&
          !rawPrimaryText
        ) {
          const primaryHasMedia = !!messages[0]?.media;
          const editLimit = primaryHasMedia ? MAX_MEDIA_CAPTION_LENGTH : MAX_TEXT_MESSAGE_LENGTH;
          const permalinkForPrimary = buildTelegramPermalinkAuto(destination, primaryDestinationId);
          let desiredPrimaryText = String(cleanedTextById.get(primarySourceId) || "");
          if (APPEND_DEST_PERMALINK && permalinkForPrimary) {
            desiredPrimaryText = appendPermalinkOnce(
              desiredPrimaryText,
              permalinkForPrimary,
              APPEND_DEST_PERMALINK_TXT
            );
          }
          desiredPrimaryText = normalizeOutgoingPartText(desiredPrimaryText);
          if (desiredPrimaryText && desiredPrimaryText.length <= editLimit) {
            await withFloodWaitRetry(
              () =>
                client.editMessage(destination, {
                  message: primaryDestinationId,
                  text: desiredPrimaryText,
                  linkPreview: false
                }),
              `set caption/text for originally-empty #${primarySourceId}`
            );
            cleanedTextById.set(primarySourceId, desiredPrimaryText);
            if (permalinkForPrimary) {
              destinationPermalinkList.push(permalinkForPrimary);
            }
          }
        }
      }

      if (
        !DRY_RUN &&
        APPEND_DEST_PERMALINK &&
        targetAdapter?.key === "dest" &&
        sentSourceIds.length > 0
      ) {
        const primarySourceId = Number(messages[0]?.id || 0);
        const primaryDestinationId = linkRewriteState.sourceToDestinationId.get(primarySourceId);
        const permalink = buildTelegramPermalinkAuto(destination, primaryDestinationId);
        if (permalink) {
          const existingText = String(cleanedTextById.get(primarySourceId) || "");
          const withPermalink = appendPermalinkOnce(
            existingText,
            permalink,
            APPEND_DEST_PERMALINK_TXT
          );
          if (withPermalink !== existingText) {
            const primaryHasMedia = !!messages[0]?.media;
            const editLimit = primaryHasMedia ? MAX_MEDIA_CAPTION_LENGTH : MAX_TEXT_MESSAGE_LENGTH;

            const tryEditPrimary = async (textToSet) =>
              withFloodWaitRetry(
                () =>
                  client.editMessage(destination, {
                    message: primaryDestinationId,
                    text: textToSet,
                    linkPreview: false
                  }),
                `append destination permalink #${primarySourceId}`
              );

            if (withPermalink.length <= editLimit) {
              await tryEditPrimary(withPermalink);
              cleanedTextById.set(primarySourceId, withPermalink);
            } else {
              const primaryMessage = messages[0];
              const rawPrimaryText = String(rawTextById.get(primarySourceId) || "");

              const decoratePartBase = (partHeader, partRawText, partFooter = "") => {
                const map = new Map();
                map.set(primarySourceId, String(partRawText || ""));
                applyPostAutoPrependLines([primaryMessage], map);
                applyPostAutoAppendLines([primaryMessage], map);
                const body = normalizeOutgoingPartText(String(map.get(primarySourceId) || ""));
                const segments = [];
                const header = String(partHeader || "").trim();
                const footer = String(partFooter || "").trim();
                if (header) segments.push(header);
                if (body) segments.push(body);
                if (footer) segments.push(footer);
                return segments.join("\n");
              };

              const buildPart1WithPermalink = (partRawText) =>
                appendPermalinkOnce(
                  decoratePartBase(
                    POST_AUTOSPLIT_TXT_HEADER_1,
                    partRawText,
                    POST_AUTOSPLIT_TXT_FOOTER_1
                  ),
                  permalink,
                  APPEND_DEST_PERMALINK_TXT
                );

              const raw = rawPrimaryText;
              let cut = Math.max(
                1,
                Math.min(raw.length - 1, preferredSplitIndex(raw, Math.floor(raw.length / 2), 0.5))
              );
              let lo = 1;
              let hi = Math.max(1, raw.length - 1);
              let best = cut;
              while (lo <= hi) {
                const mid = Math.floor((lo + hi) / 2);
                const safeMid = makeReadableSplitCut(raw, mid, 1);
                const candidate = buildPart1WithPermalink(raw.slice(0, safeMid).trimEnd());
                if (candidate.length <= editLimit) {
                  best = safeMid;
                  lo = mid + 1;
                } else {
                  hi = mid - 1;
                }
              }
              const finalCutInfo = getReadableSplitCutInfo(
                raw,
                Math.max(1, Math.min(raw.length - 1, best)),
                1
              );
              cut = finalCutInfo.cut;
              const part1Raw = raw.slice(0, cut).trimEnd();
              const part2Raw = raw.slice(cut).trimStart();

              if (!part2Raw) {
                const safe = clampText(withPermalink, editLimit);
                await tryEditPrimary(safe);
                cleanedTextById.set(primarySourceId, safe);
              } else {
                const part1Final = buildPart1WithPermalink(part1Raw);
                await tryEditPrimary(clampText(part1Final, editLimit));
                cleanedTextById.set(primarySourceId, clampText(part1Final, editLimit));

                const part2Base = decoratePartBase(POST_AUTOSPLIT_TXT_HEADER_2, part2Raw, "");
                const part2Sent = await withFloodWaitRetry(
                  () =>
                    client.sendMessage(destination, {
                      message: clampText(part2Base, MAX_TEXT_MESSAGE_LENGTH),
                      linkPreview: false
                    }),
                  `split overflow part 2/2 #${primarySourceId}`
                );
                const part2Id = Number(part2Sent?.id || 0);
                if (Number.isInteger(part2Id) && part2Id > 0) {
                  const part2Permalink = buildTelegramPermalinkAuto(destination, part2Id);
                  if (part2Permalink) {
                    destinationPermalinkList.push(part2Permalink);
                    const part2WithPermalink = appendPermalinkOnce(
                      part2Base,
                      part2Permalink,
                      APPEND_DEST_PERMALINK_TXT
                    );
                    await withFloodWaitRetry(
                      () =>
                        client.editMessage(destination, {
                          message: part2Id,
                          text: clampText(part2WithPermalink, MAX_TEXT_MESSAGE_LENGTH),
                          linkPreview: false
                        }),
                      `append destination permalink 2/2 #${primarySourceId}`
                    );
                  }
                }
                logInfo(`split_cut: ${finalCutInfo.mode} at ${cut}/${raw.length}`);
                logInfo(`permalink_split: split #${primarySourceId} into 1/2 and 2/2 due caption limit`);
              }
            }
          }
        }
      }

      if (!DRY_RUN && sentSourceIds.length > 0) {
        let destinationPermalink = primaryDestinationPermalink;
        if (targetAdapter?.key === "dest") {
          const primarySourceId = Number(messages[0]?.id || 0);
          const primaryDestinationId = linkRewriteState.sourceToDestinationId.get(primarySourceId);
          destinationPermalink = buildTelegramPermalinkAuto(destination, primaryDestinationId);
          if (destinationPermalink) {
            destinationPermalinkList = [
              destinationPermalink,
              ...destinationPermalinkList.filter((x) => String(x || "").trim() !== destinationPermalink)
            ];
          }
        }
        for (const sourceId of sentSourceIds) processedSourceIds.add(Number(sourceId));
        if (shouldUpdateArchivePost) {
          updatePostedPostInDb(
            archiveDb,
            effectiveArchivePairKey,
            messages,
            cleanedTextById,
            linkRewriteState.sourceToDestinationId,
            destinationPermalink,
            destinationPermalinkList
          );
        }
        markCloneMessagesPostedInDb(
          archiveDb,
          pairKey,
          sentSourceIds,
          linkRewriteState.sourceToDestinationId
        );
      }

      copied += sentCount;
      skipped += messages.length - sentCount;
      if (!DRY_RUN && (sentSourceIds.length > 0 || mappingChanged > 0)) {
        persistArchiveState();
      }
      return sentCount > 0 ? "added" : "skipped";
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

  if (!IS_SRC2LOCAL) {
    const totalPreparedMessages = countPreparedUnitMessages(preparedUnits);
    let postProgressMessages = 0;
    logInfo(`posting pass starting... units=${preparedUnits.length} messages=${totalPreparedMessages}`);
    if (preparedUnits.length === 0) {
      logInfo("post status=none duration=less than a second progress=0/0");
    }
    for (let i = 0; i < preparedUnits.length; i += 1) {
      if (i > 0) {
        console.log(buildSeparatorLine());
      }
      const unit = preparedUnits[i];
      const unitStartedAt = Date.now();
      logProcessingInfo(unit.messages);
      const postStatus = (await postPreparedUnit(unit.messages)) || "skipped";
      const postUnitDurationText = formatRunDuration(Date.now() - unitStartedAt);
      postProgressMessages += unit.messages.length;
      logInfo(
        `post status=${postStatus} duration=${postUnitDurationText} progress=${postProgressMessages}/${totalPreparedMessages}`
      );
      if (!DRY_RUN) {
        const postPacingStage =
          targetAdapter?.key === "blogger"
            ? "blogger"
            : targetAdapter?.key === "wp-com"
              ? "wpcom"
              : targetAdapter?.key === "bsky"
                ? "bsky"
              : "post";
        await sleepWithAdaptivePacing(postPacingStage, "between post units");
        const batchEvery =
          targetAdapter?.key === "blogger"
            ? BLOGGER_BATCH_EVERY
            : targetAdapter?.key === "wp-com"
              ? WP_COM_BATCH_EVERY
              : 0;
        const batchPauseRange =
          targetAdapter?.key === "blogger"
            ? BLOGGER_BATCH_PAUSE_RANGE
            : targetAdapter?.key === "wp-com"
              ? WP_COM_BATCH_PAUSE_RANGE
              : { min: 0, max: 0 };
        const batchLabel = targetAdapter?.key === "wp-com" ? "wpcom" : "blogger";
        if (
          Number.isInteger(batchEvery) &&
          batchEvery > 0 &&
          (i + 1) % batchEvery === 0 &&
          i + 1 < preparedUnits.length
        ) {
          const minMs = Math.max(0, Number(batchPauseRange?.min || 0));
          const maxMs = Math.max(minMs, Number(batchPauseRange?.max || minMs));
          const pauseMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
          if (pauseMs > 0) {
            logInfo(`post_stage: ${batchLabel} batch pause after ${i + 1} unit(s) -> waiting ${pauseMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, pauseMs));
          }
        }
      }
    }
    console.log(`Posting pass complete. PreparedUnits=${preparedUnits.length}`);
  }

  return {
    copied,
    skipped
  };
}

module.exports = {
  runPostingPass
};
