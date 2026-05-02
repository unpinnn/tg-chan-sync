"use strict";

const fs = require("fs");
const path = require("path");

function createBskyTargetAdapter(deps = {}) {
  const getBskyClient = deps.getBskyClient;
  const withHeartbeatLog = deps.withHeartbeatLog;
  const sleepWithAdaptivePacing = deps.sleepWithAdaptivePacing;
  const logInfo = typeof deps.logInfo === "function" ? deps.logInfo : null;
  const getPostArchiveRow = deps.getPostArchiveRow;
  const bskyReset = !!deps.bskyReset;
  const bskyEnableVideo = !!deps.bskyEnableVideo;
  const bskyTags = Array.isArray(deps.bskyTags) ? deps.bskyTags : [];
  const bskyTextMax = Math.max(
    20,
    Number.parseInt(String(deps.bskyTextMax || 300), 10) || 300
  );
  const bskyImagesMax = Math.max(
    1,
    Math.min(4, Number.parseInt(String(deps.bskyImagesMax || 4), 10) || 4)
  );
  const bskyImageMaxBytes = Math.max(
    10000,
    Number.parseInt(String(deps.bskyImageMaxBytes || 1000000), 10) || 1000000
  );
  const bskyRetryMax = Math.max(
    0,
    Number.parseInt(String(deps.bskyRetryMax || 4), 10) || 4
  );
  const bskyRetryWaitRange = deps.bskyRetryWaitRange || { min: 3000, max: 9000 };
  const bskyPollRange = deps.bskyPollRange || { min: 2000, max: 8000 };

  if (typeof getBskyClient !== "function") {
    throw new Error("createBskyTargetAdapter: getBskyClient is required");
  }
  if (typeof withHeartbeatLog !== "function") {
    throw new Error("createBskyTargetAdapter: withHeartbeatLog is required");
  }
  if (typeof getPostArchiveRow !== "function") {
    throw new Error("createBskyTargetAdapter: getPostArchiveRow is required");
  }
  let resolvedIdentity = null;

  function assertPostMode(postMode) {
    const mode = String(postMode || "").toLowerCase();
    if (mode !== "own-post") {
      throw new Error(`Unsupported POST_MODE "${postMode}" for bsky target. Use POST_MODE=own-post.`);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomIntInclusive(minValue, maxValue) {
    const min = Math.max(0, Math.floor(Number(minValue || 0)));
    const max = Math.max(min, Math.floor(Number(maxValue || 0)));
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  
  function buildPermalinkLine(url) {
    const link = String(url || "").trim();
    if (!link) return "";
    return link;
  }

  function splitTrailingPunctuation(text) {
    let core = String(text || "");
    let trailing = "";
    while (core.length > 0 && /[)\].,!?;:]/.test(core.slice(-1))) {
      trailing = core.slice(-1) + trailing;
      core = core.slice(0, -1);
    }
    return { core, trailing };
  }

  function findUrlRanges(text) {
    const value = String(text || "");
    const ranges = [];
    const re = /https?:\/\/[^\s<>"'`]+/gi;
    let match;
    while ((match = re.exec(value)) !== null) {
      const raw = String(match[0] || "");
      if (!raw) continue;
      const { core } = splitTrailingPunctuation(raw);
      if (!core) continue;
      const start = Number(match.index || 0);
      const end = start + core.length;
      if (end > start) ranges.push({ start, end });
    }
    return ranges;
  }

  function safeTrimToLength(text, limit, suffix = "...") {
    const value = String(text || "");
    const max = Math.max(1, Number(limit || 0));
    if (value.length <= max) return value;
    const endSuffix = String(suffix || "");
    const available = Math.max(1, max - endSuffix.length);
    const urlRanges = findUrlRanges(value);
    let cut = available;

    for (;;) {
      const inUrl = urlRanges.find((r) => cut > r.start && cut < r.end);
      if (!inUrl) break;
      cut = inUrl.start;
      if (cut <= 0) break;
    }

    if (cut <= 0) {
      return `${value.slice(0, available).trimEnd()}${endSuffix}`;
    }

    let wordCut = cut;
    while (wordCut > 0 && !/[\s,.;:!?)\]}]/.test(value[wordCut - 1])) {
      wordCut -= 1;
    }
    const minReadable = Math.max(12, Math.floor(available * 0.6));
    if (wordCut >= minReadable) cut = wordCut;

    return `${value.slice(0, cut).trimEnd()}${endSuffix}`;
  }

  function compressSingleTextWithLead(baseText, maxChars, leadLine) {
    const max = Math.max(20, Number(maxChars || 300));
    const lead = String(leadLine || "").trim();
    const body = String(baseText || "").trim();
    if (!lead && !body) return "";
    if (!lead) return safeTrimToLength(body, max);
    if (!body) return safeTrimToLength(lead, max);

    const glue = "\n\n";
    const reserved = lead.length + glue.length;
    if (reserved >= max - 10) return safeTrimToLength(lead, max);

    const bodyMax = max - reserved;
    const bodyCompressed = safeTrimToLength(body, bodyMax);
    return `${lead}${glue}${bodyCompressed}`.trim();
  }

  function buildUrlFacets(text) {
    const value = String(text || "");
    if (!value) return [];
    const facets = [];
    const re = /https?:\/\/[^\s<>"'`]+/gi;
    let match;
    while ((match = re.exec(value)) !== null) {
      const raw = String(match[0] || "");
      if (!raw) continue;
      const { core } = splitTrailingPunctuation(raw);
      if (!core) continue;
      const startChar = Number(match.index || 0);
      const byteStart = Buffer.byteLength(value.slice(0, startChar), "utf8");
      const byteEnd = byteStart + Buffer.byteLength(core, "utf8");
      facets.push({
        index: { byteStart, byteEnd },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: core }]
      });
    }
    return facets;
  }


  function mimeTypeFromPath(filePath) {
    const ext = String(path.extname(String(filePath || "")).toLowerCase());
    const map = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm"
    };
    return map[ext] || "application/octet-stream";
  }

  function isImageMime(mimeType) {
    return /^image\//i.test(String(mimeType || ""));
  }

  function isVideoMime(mimeType) {
    return /^video\//i.test(String(mimeType || ""));
  }

  function stageLine(text) {
    return `post_stage: bsky ${String(text || "").trim()}`.trim();
  }

  function extractHttpStatusFromError(error) {
    const directStatus = Number(error?.status || error?.statusCode || 0);
    if (Number.isFinite(directStatus) && directStatus > 0) {
      return directStatus;
    }
    const msg = String(error?.message || error || "");
    const match = msg.match(/\((\d{3})\)/);
    if (match) return Number.parseInt(match[1], 10);
    return 0;
  }

  function isTransientBskyError(error) {
    const status = extractHttpStatusFromError(error);
    const msg = String(error?.message || error || "").toLowerCase();
    if (status === 429 || status >= 500) return true;
    if (status === 400 && /(rate|temporar|timeout|upstream)/i.test(msg)) return true;
    if (/etimedout|econnreset|eai_again|network|fetch failed|socket|temporar/i.test(msg)) return true;
    return false;
  }

  async function waitBeforeRetry(reason, attemptNo) {
    const jitterMs = randomIntInclusive(bskyRetryWaitRange.min, bskyRetryWaitRange.max);
    const waitMs = jitterMs * Math.max(1, attemptNo);
    if (typeof sleepWithAdaptivePacing === "function") {
      await sleepWithAdaptivePacing("bsky", `${reason} retry ${attemptNo}`);
    }
    if (logInfo) {
      logInfo(`post_stage: bsky retry ${attemptNo}/${bskyRetryMax} -> waiting ${waitMs}ms`);
    }
    await sleep(waitMs);
  }

  async function callBskyWithRetry(label, action) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await action();
      } catch (error) {
        if (attempt > bskyRetryMax || !isTransientBskyError(error)) {
          throw error;
        }
        await waitBeforeRetry(label, attempt);
      }
    }
  }

  async function ensureIdentity() {
    if (resolvedIdentity?.did) return resolvedIdentity;
    const bsky = getBskyClient();
    const session = await withHeartbeatLog(stageLine("resolve identity"), () =>
      callBskyWithRetry("resolve identity", () => bsky.getSession())
    );
    let did = String(session?.did || "").trim();
    let handle = String(session?.handle || "").trim();
    if (!handle) {
      const identity = bsky.getIdentity();
      handle = String(identity?.handle || "").trim();
      did = String(identity?.did || did).trim();
    }
    if (!did) {
      throw new Error("Could not resolve Bluesky DID from session.");
    }
    if (!handle) {
      const profile = await withHeartbeatLog(stageLine("resolve profile"), () =>
        callBskyWithRetry("resolve profile", () => bsky.getProfile(did))
      );
      handle = String(profile?.handle || "").trim();
    }
    resolvedIdentity = { did, handle };
    if (logInfo) {
      logInfo(`post_stage: bsky target ${did}${handle ? ` (${handle})` : ""}`);
    }
    return resolvedIdentity;
  }

  function parseAtUri(uri) {
    const raw = String(uri || "").trim();
    const match = raw.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/);
    if (!match) return null;
    return {
      repo: match[1],
      collection: match[2],
      rkey: match[3]
    };
  }

  function buildPermalink(handle, uri) {
    const cleanHandle = String(handle || "").trim();
    const parsed = parseAtUri(uri);
    if (!cleanHandle || !parsed || parsed.collection !== "app.bsky.feed.post") return "";
    return `https://bsky.app/profile/${cleanHandle}/post/${parsed.rkey}`;
  }

  async function deleteAllDestinationPosts() {
    const bsky = getBskyClient();
    const identity = await ensureIdentity();
    if (logInfo) logInfo("bsky_reset: deleting destination posts...");
    const uris = await withHeartbeatLog(stageLine("list existing posts"), () =>
      callBskyWithRetry("list existing posts", () => bsky.listOwnPostUris(10000))
    );
    let deleted = 0;
    for (const uri of uris) {
      await withHeartbeatLog(stageLine(`delete ${uri}`), () =>
        callBskyWithRetry("delete post", () => bsky.deletePostByUri(uri))
      );
      deleted += 1;
      if (deleted % 25 === 0 && typeof sleepWithAdaptivePacing === "function") {
        await sleepWithAdaptivePacing("bsky", "bsky reset pacing");
      }
    }
    if (logInfo) logInfo(`bsky_reset: deleted posts=${deleted} actor=${identity.did}`);
  }

  async function preflightBeforeRun(ctx = {}) {
    if (ctx.DRY_RUN) {
      if (logInfo) logInfo("bsky_preflight: DRY_RUN=true; skipping write-check.");
      return;
    }
    const bsky = getBskyClient();
    await ensureIdentity();
    let probeUri = "";
    try {
      if (logInfo) logInfo("bsky_preflight: checking write access...");
      const created = await withHeartbeatLog(stageLine("preflight create post"), () =>
        callBskyWithRetry("preflight create post", () =>
          bsky.createPostRecord({
            text: `local2bsky preflight ${new Date().toISOString()}`
          })
        )
      );
      probeUri = String(created?.uri || "").trim();
      if (!probeUri) {
        throw new Error("preflight post created without uri");
      }
      await withHeartbeatLog(stageLine("preflight delete post"), () =>
        callBskyWithRetry("preflight delete post", () => bsky.deletePostByUri(probeUri))
      );
      if (logInfo) logInfo("bsky_preflight: write access ok.");
    } catch (error) {
      const msg = String(error?.message || error || "");
      if (/403|401|permission|forbidden|access denied|auth/i.test(msg)) {
        throw new Error(
          "Bluesky preflight failed: no write access for this account/app password. " +
            "Check BSKY_IDENTIFIER, BSKY_APP_PASSWORD, and account verification."
        );
      }
      throw new Error(`Bluesky preflight failed: ${msg}`);
    }
  }

  async function resetBeforePosting(ctx = {}) {
    if (!bskyReset) return;
    if (ctx.DRY_RUN) {
      if (logInfo) logInfo("bsky_reset: requested but DRY_RUN=true; skipping destination wipe.");
      return;
    }
    if (typeof ctx.resetPairPostingState !== "function") {
      throw new Error("bsky_reset requires resetPairPostingState helper.");
    }
    await deleteAllDestinationPosts();
    ctx.resetPairPostingState(ctx.archiveDb, String(ctx.pairKey || ""));
    if (typeof ctx.persistArchiveState === "function") {
      ctx.persistArchiveState();
    }
    if (ctx.processedSourceIds && typeof ctx.processedSourceIds.clear === "function") {
      ctx.processedSourceIds.clear();
    }
    if (
      ctx.linkRewriteState?.sourceToDestinationId &&
      typeof ctx.linkRewriteState.sourceToDestinationId.clear === "function"
    ) {
      ctx.linkRewriteState.sourceToDestinationId.clear();
    }
    if (logInfo) logInfo("bsky_reset: cleared posted-state mappings for current source->bsky pair.");
  }

  function buildCombinedText(messages, cleanedTextById) {
    const parts = [];
    for (const message of messages) {
      const sourceId = Number.parseInt(String(message?.id || 0), 10);
      if (!Number.isInteger(sourceId) || sourceId <= 0) continue;
      const text = String(cleanedTextById.get(sourceId) || "").trim();
      if (!text) continue;
      parts.push(text);
    }
    return parts.join("\n\n");
  }

  function buildTagSuffix() {
    const tags = bskyTags
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .map((x) => (x.startsWith("#") ? x : `#${x.replace(/^#+/, "")}`));
    if (!tags.length) return "";
    return tags.join(" ");
  }

  function groupArray(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(items.slice(i, i + size));
    }
    return out;
  }

  async function uploadImageEmbeds(mediaItems) {
    if (!mediaItems.length) return [];
    const bsky = getBskyClient();
    const embeds = [];
    for (const group of groupArray(mediaItems, bskyImagesMax)) {
      const images = [];
      for (const media of group) {
        const bytes = fs.readFileSync(media.path);
        const blob = await withHeartbeatLog(stageLine(`upload image ${media.name}`), () =>
          callBskyWithRetry(`upload image ${media.name}`, () =>
            bsky.uploadBlob({ bytes, mimeType: media.mimeType })
          )
        );
        images.push({
          alt: media.name,
          image: blob
        });
      }
      if (images.length > 0) {
        embeds.push({
          $type: "app.bsky.embed.images",
          images
        });
      }
    }
    return embeds;
  }

  async function uploadVideoEmbeds(videoItems) {
    if (!videoItems.length) return [];
    const bsky = getBskyClient();
    const embeds = [];
    for (const media of videoItems) {
      const bytes = fs.readFileSync(media.path);
      const blob = await withHeartbeatLog(stageLine(`upload video ${media.name}`), () =>
        callBskyWithRetry(`upload video ${media.name}`, () =>
          bsky.uploadBlob({ bytes, mimeType: media.mimeType })
        )
      );
      embeds.push({
        $type: "app.bsky.embed.video",
        video: blob,
        alt: media.name
      });
      if (bskyPollRange.max > 0) {
        const waitMs = randomIntInclusive(bskyPollRange.min, bskyPollRange.max);
        await sleep(waitMs);
      }
    }
    return embeds;
  }

  async function postMessages(input = {}) {
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const cleanedTextById = input.cleanedTextById instanceof Map ? input.cleanedTextById : new Map();
    const downloadedMediaById =
      input.downloadedMediaById instanceof Map ? input.downloadedMediaById : new Map();
    if (!messages.length) {
      return { sentCount: 0, mappingChanged: 0, sentSourceIds: [] };
    }

    const identity = await ensureIdentity();

    const mediaItems = [];
    for (const message of messages) {
      const sourceId = Number.parseInt(String(message?.id || 0), 10);
      if (!Number.isInteger(sourceId) || sourceId <= 0) continue;
      const mediaPath = String(downloadedMediaById.get(sourceId) || "").trim();
      if (!mediaPath || !fs.existsSync(mediaPath)) continue;
      const stats = fs.statSync(mediaPath);
      const mimeType = mimeTypeFromPath(mediaPath);
      mediaItems.push({
        sourceId,
        path: mediaPath,
        name: path.basename(mediaPath),
        mimeType,
        size: Number(stats.size || 0)
      });
    }

    const imageCandidates = [];
    const videoCandidates = [];
    for (const media of mediaItems) {
      if (isImageMime(media.mimeType)) {
        if (media.size <= bskyImageMaxBytes) {
          imageCandidates.push(media);
        }
      } else if (isVideoMime(media.mimeType)) {
        if (bskyEnableVideo) {
          videoCandidates.push(media);
        }
      }
    }

    const selectedImages = imageCandidates.slice(0, bskyImagesMax);

    let selectedVideo = null;
    if (videoCandidates.length > 0 && selectedImages.length === 0) {
      selectedVideo = videoCandidates[0];
    }

    const imageEmbeds = await uploadImageEmbeds(selectedImages);
    const videoEmbeds = selectedVideo ? await uploadVideoEmbeds([selectedVideo]) : [];
    const embed = imageEmbeds[0] || videoEmbeds[0] || null;

    const primarySourceId = Number.parseInt(String(messages[0]?.id || 0), 10);
    const archiveRow = getPostArchiveRow(input.archiveDb, String(input.archivePairKey || ""), primarySourceId) || {};
    const archiveTelegramPermalink = String(
      archiveRow.destinationPermalink || archiveRow.destinationPermalinkDerived || ""
    ).trim();
    if (!archiveTelegramPermalink && logInfo) {
      const ids = Array.isArray(archiveRow.destinationMessageIds)
        ? archiveRow.destinationMessageIds.filter((x) => Number.isInteger(x) && x > 0)
        : [];
      const fallbackId = Number(archiveRow.fallbackDestinationMessageId || 0);
      logInfo(
        `post_stage: bsky permalink debug source=#${primarySourceId} pair=${String(
          input.archivePairKey || ""
        )} missing (saved=no, derived=no, dest_ids=${
          ids.length ? ids.join(",") : "none"
        }, fallback_id=${fallbackId > 0 ? String(fallbackId) : "none"})`
      );
    }

    const baseText = buildCombinedText(messages, cleanedTextById);
    const tagSuffix = buildTagSuffix();
    const permalinkLine = buildPermalinkLine(archiveTelegramPermalink);
    const bodyParts = [];
    if (baseText) bodyParts.push(baseText);
    if (tagSuffix) bodyParts.push(tagSuffix);
    const fullBodyText = bodyParts.join("\n\n").trim();
    const finalText = compressSingleTextWithLead(fullBodyText, bskyTextMax, permalinkLine);
    const facets = buildUrlFacets(finalText);

    const bsky = getBskyClient();
    const rangeLabel = messages.length > 1
      ? `#${messages[0].id}-#${messages[messages.length - 1].id}`
      : `#${messages[0].id}`;
    const created = await withHeartbeatLog(stageLine(`posting ${rangeLabel}`), () =>
      callBskyWithRetry(`post ${rangeLabel}`, () =>
        bsky.createPostRecord({
          text: finalText || " ",
          embed,
          facets
        })
      )
    );
    const uri = String(created?.uri || "").trim();
    if (!uri) {
      throw new Error(`Bluesky post create did not return uri for ${rangeLabel}.`);
    }

    const sentSourceIds = messages
      .map((m) => Number.parseInt(String(m?.id || 0), 10))
      .filter((x) => Number.isInteger(x) && x > 0);
    return {
      sentCount: sentSourceIds.length,
      mappingChanged: 0,
      sentSourceIds,
      primaryDestinationPermalink: ""
    };
  }

  return {
    key: "bsky",
    label: "bluesky",
    assertPostMode,
    preflightBeforeRun,
    resetBeforePosting,
    postMessages
  };
}

module.exports = {
  createBskyTargetAdapter
};
