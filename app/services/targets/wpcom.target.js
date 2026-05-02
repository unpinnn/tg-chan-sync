"use strict";

const fs = require("fs");
const path = require("path");

function createWpComTargetAdapter(deps = {}) {
  const getWpComClient = deps.getWpComClient;
  const withHeartbeatLog = deps.withHeartbeatLog;
  const sleepWithAdaptivePacing = deps.sleepWithAdaptivePacing;
  const logInfo = typeof deps.logInfo === "function" ? deps.logInfo : null;
  const getPostArchiveRow = deps.getPostArchiveRow;
  const mainSiteIdInput = String(deps.mainSiteId || "").trim();
  const mediaSiteIdsInput = Array.isArray(deps.mediaSiteIds) ? deps.mediaSiteIds : [];
  const mediaStrategy = String(deps.mediaStrategy || "round-robin").trim().toLowerCase();
  const mediaFailover = !!deps.mediaFailover;
  const wpTags = Array.isArray(deps.wpTags) ? deps.wpTags : [];
  const wpReset = !!deps.wpReset;
  const wpRetryMax = Math.max(0, Number.parseInt(String(deps.wpRetryMax || 4), 10) || 4);
  const wpRetryWaitRange = deps.wpRetryWaitRange || { min: 4000, max: 10000 };

  if (typeof getWpComClient !== "function") {
    throw new Error("createWpComTargetAdapter: getWpComClient is required");
  }
  if (typeof withHeartbeatLog !== "function") {
    throw new Error("createWpComTargetAdapter: withHeartbeatLog is required");
  }
  if (typeof getPostArchiveRow !== "function") {
    throw new Error("createWpComTargetAdapter: getPostArchiveRow is required");
  }

  const mediaSiteIds = Array.from(
    new Set(
      mediaSiteIdsInput
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );

  if (!mainSiteIdInput) {
    throw new Error("local2wp.com requires WP_COM_MAIN_SITE_ID.");
  }
  if (!["round-robin", "fill-first"].includes(mediaStrategy)) {
    throw new Error("WP_COM_MEDIA_STRATEGY must be 'round-robin' or 'fill-first'.");
  }

  let resolvedSites = null;
  let roundRobinIndex = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomIntInclusive(minValue, maxValue) {
    const min = Math.max(0, Math.floor(Number(minValue || 0)));
    const max = Math.max(min, Math.floor(Number(maxValue || 0)));
    return Math.floor(Math.random() * (max - min + 1)) + min;
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

  function isTransientWpError(error) {
    const status = extractHttpStatusFromError(error);
    const msg = String(error?.message || error || "").toLowerCase();
    if (status === 429 || status >= 500) return true;
    if (status === 403 && /(ratelimit|quota|temporar|resource limits)/i.test(msg)) return true;
    if (/etimedout|econnreset|eai_again|network|fetch failed|socket|temporar/i.test(msg)) return true;
    return false;
  }

  async function waitBeforeRetry(reason, attemptNo) {
    const jitterMs = randomIntInclusive(wpRetryWaitRange.min, wpRetryWaitRange.max);
    const waitMs = jitterMs * Math.max(1, attemptNo);
    if (typeof sleepWithAdaptivePacing === "function") {
      await sleepWithAdaptivePacing("wpcom", `${reason} retry ${attemptNo}`);
    }
    if (logInfo) {
      logInfo(`post_stage: wpcom retry ${attemptNo}/${wpRetryMax} -> waiting ${waitMs}ms`);
    }
    await sleep(waitMs);
  }

  async function callWpWithRetry(label, action) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await action();
      } catch (error) {
        if (attempt > wpRetryMax || !isTransientWpError(error)) {
          throw error;
        }
        await waitBeforeRetry(label, attempt);
      }
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function linkifyPlainText(value) {
    const raw = String(value || "");
    const re = /(https?:\/\/[^\s<>"'`]+)/g;
    let out = "";
    let last = 0;
    let match = null;
    while ((match = re.exec(raw))) {
      const url = String(match[0] || "");
      const start = match.index;
      out += escapeHtml(raw.slice(last, start));
      out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        url
      )}</a>`;
      last = start + url.length;
    }
    out += escapeHtml(raw.slice(last));
    return out;
  }

  function normalizeTextToHtml(value) {
    const text = String(value || "").replace(/\r\n?/g, "\n").trim();
    if (!text) return "";
    return linkifyPlainText(text).replace(/\n/g, "<br>\n");
  }

  function mimeTypeFromPath(filePath) {
    const ext = String(path.extname(String(filePath || "")).toLowerCase());
    const map = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".wav": "audio/wav",
      ".pdf": "application/pdf"
    };
    return map[ext] || "application/octet-stream";
  }

  function extFromPath(filePath) {
    const ext = String(path.extname(String(filePath || "")).toLowerCase());
    return ext.startsWith(".") ? ext.slice(1) : ext;
  }

  function collectCombinedText(messages, cleanedTextById) {
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

  function extractTitleFromPostTxt(postTxtPath, fallbackTitle = "") {
    const absPath = String(postTxtPath || "").trim();
    if (!absPath || !fs.existsSync(absPath)) return String(fallbackTitle || "").trim();
    const raw = String(fs.readFileSync(absPath, "utf8") || "");
    const line = raw.split(/\r?\n/).find((x) => /^title\s*:/i.test(x));
    if (!line) return String(fallbackTitle || "").trim();
    const parsed = line.replace(/^title\s*:/i, "").trim();
    return parsed || String(fallbackTitle || "").trim();
  }

  function parsePostPermalink(payload) {
    if (!payload || typeof payload !== "object") return "";
    return String(payload.URL || payload.url || payload.link || "").trim();
  }

  function parsePostId(payload) {
    if (!payload || typeof payload !== "object") return "";
    return String(payload.ID || payload.id || "").trim();
  }

  async function ensureResolvedSites() {
    if (resolvedSites) return resolvedSites;
    const wp = getWpComClient();
    const mainSite = await withHeartbeatLog("post_stage: wpcom resolve main site", () =>
      callWpWithRetry("resolve main site", () => wp.getSite(mainSiteIdInput))
    );
    if (!String(mainSite?.id || "").trim()) {
      throw new Error(`Could not resolve WP_COM_MAIN_SITE_ID="${mainSiteIdInput}".`);
    }

    const mediaPool = [];
    for (const siteId of mediaSiteIds) {
      const siteInfo = await withHeartbeatLog(`post_stage: wpcom resolve media site ${siteId}`, () =>
        callWpWithRetry(`resolve media site ${siteId}`, () => wp.getSite(siteId))
      );
      if (!String(siteInfo?.id || "").trim()) continue;
      mediaPool.push(siteInfo);
    }
    if (mediaPool.length === 0) {
      mediaPool.push(mainSite);
    }

    resolvedSites = { mainSite, mediaPool };
    if (logInfo) {
      const mediaIds = mediaPool.map((x) => String(x.id || "")).join(",");
      logInfo(
        `post_stage: wpcom target main=${mainSite.id}${mainSite?.url ? ` ${mainSite.url}` : ""} media_pool=${mediaIds}`
      );
    }
    return resolvedSites;
  }

  function nextMediaSiteOrder() {
    const pool = (resolvedSites?.mediaPool || []).slice();
    if (pool.length <= 1) return pool;
    if (mediaStrategy === "fill-first") return pool;
    const start = roundRobinIndex % pool.length;
    const ordered = [];
    for (let i = 0; i < pool.length; i += 1) {
      ordered.push(pool[(start + i) % pool.length]);
    }
    roundRobinIndex = (roundRobinIndex + 1) % pool.length;
    return ordered;
  }

  async function uploadMediaToPool(mediaPath) {
    const wp = getWpComClient();
    const bytes = fs.readFileSync(mediaPath);
    const fileName = path.basename(mediaPath);
    const mimeType = mimeTypeFromPath(mediaPath);
    const orderedSites = nextMediaSiteOrder();
    let lastError = null;
    for (let idx = 0; idx < orderedSites.length; idx += 1) {
      const site = orderedSites[idx];
      const allowedTypes = Array.isArray(site?.allowedFileTypes)
        ? site.allowedFileTypes.map((x) => String(x || "").toLowerCase()).filter(Boolean)
        : [];
      const ext = extFromPath(mediaPath);
      if (allowedTypes.length > 0 && ext && !allowedTypes.includes(ext)) {
        lastError = new Error(
          `File type ".${ext}" is not allowed on site ${site.id}. Allowed: ${allowedTypes.join(", ")}`
        );
        if (!mediaFailover || idx >= orderedSites.length - 1) {
          throw lastError;
        }
        if (logInfo) {
          logInfo(
            `post_stage: wpcom upload failover ${fileName} site ${site.id} -> next (${lastError.message})`
          );
        }
        continue;
      }
      try {
        const uploaded = await withHeartbeatLog(
          `post_stage: wpcom upload ${fileName} -> site ${site.id}`,
          () =>
            callWpWithRetry(`upload ${fileName} site ${site.id}`, () =>
              wp.uploadMedia(site.id, { fileName, mimeType, bytes })
            )
        );
        return {
          url: String(uploaded?.url || "").trim(),
          mediaId: String(uploaded?.mediaId || "").trim(),
          siteId: String(site.id || "").trim(),
          mimeType
        };
      } catch (error) {
        lastError = error;
        if (!mediaFailover || idx >= orderedSites.length - 1) {
          throw error;
        }
        if (logInfo) {
          logInfo(
            `post_stage: wpcom upload failover ${fileName} site ${site.id} -> next (${error?.message || error})`
          );
        }
      }
    }
    throw lastError || new Error("Media upload failed.");
  }

  function buildMediaHtml(uploadedMedia = []) {
    const parts = [];
    for (const item of uploadedMedia) {
      const url = String(item?.url || "").trim();
      if (!url) continue;
      const mimeType = String(item?.mimeType || "").trim().toLowerCase();
      if (mimeType.startsWith("image/")) {
        parts.push(`<p><img src="${escapeHtml(url)}" alt="" style="max-width:100%;height:auto;" /></p>`);
      } else if (mimeType.startsWith("video/")) {
        parts.push(`<p><video controls src="${escapeHtml(url)}" style="max-width:100%;height:auto;"></video></p>`);
      } else if (mimeType.startsWith("audio/")) {
        parts.push(`<p><audio controls src="${escapeHtml(url)}"></audio></p>`);
      } else {
        parts.push(
          `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            path.basename(url)
          )}</a></p>`
        );
      }
    }
    return parts.join("\n");
  }

  function buildFailedMediaNoteHtml(failedUploads = []) {
    if (!Array.isArray(failedUploads) || failedUploads.length === 0) return "";
    const items = failedUploads
      .map((item) => {
        const file = escapeHtml(String(item?.fileName || "attachment"));
        const reason = escapeHtml(String(item?.error || "upload failed"));
        return `<li>${file} (not embedded: ${reason})</li>`;
      })
      .join("");
    return `<p><strong>Attachments not embedded:</strong></p><ul>${items}</ul>`;
  }

  async function listAllPostsMainSite(mainSiteId) {
    const wp = getWpComClient();
    const out = [];
    let page = 1;
    for (;;) {
      const payload = await withHeartbeatLog(`post_stage: wpcom list posts page ${page}`, () =>
        callWpWithRetry(`list posts page ${page}`, () =>
          wp.listPosts(mainSiteId, { status: "publish,draft,pending,private,future", page, number: 100 })
        )
      );
      const items = Array.isArray(payload?.posts) ? payload.posts : [];
      for (const item of items) out.push(item);
      if (!items.length) break;
      if (items.length < 100) break;
      page += 1;
      if (page > 2000) break;
    }
    return out;
  }

  function extractMediaItems(payload) {
    if (!payload || typeof payload !== "object") return [];
    if (Array.isArray(payload.media)) return payload.media;
    if (payload.media && typeof payload.media === "object") {
      return Object.values(payload.media);
    }
    return [];
  }

  function parseMediaId(item) {
    if (!item || typeof item !== "object") return "";
    return String(item.ID || item.id || "").trim();
  }

  async function listAllMediaForSite(siteId) {
    const wp = getWpComClient();
    const out = [];
    let page = 1;
    for (;;) {
      const payload = await withHeartbeatLog(`post_stage: wpcom list media ${siteId} page ${page}`, () =>
        callWpWithRetry(`list media ${siteId} page ${page}`, () =>
          wp.listMedia(siteId, { page, number: 100 })
        )
      );
      const items = extractMediaItems(payload);
      for (const item of items) out.push(item);
      if (!items.length) break;
      if (items.length < 100) break;
      page += 1;
      if (page > 2000) break;
    }
    return out;
  }

  function assertPostMode(postMode) {
    const mode = String(postMode || "").toLowerCase();
    if (mode !== "own-post") {
      throw new Error(
        `Unsupported POST_MODE "${postMode}" for wp-com target. Use POST_MODE=own-post.`
      );
    }
  }

  async function preflightBeforeRun(ctx = {}) {
    if (ctx.DRY_RUN) {
      if (logInfo) logInfo("wpcom_preflight: DRY_RUN=true; skipping write-check.");
      return;
    }
    const sites = await ensureResolvedSites();
    const wp = getWpComClient();
    let created = null;
    try {
      if (logInfo) logInfo("wpcom_preflight: checking write access...");
      created = await withHeartbeatLog("post_stage: wpcom preflight create draft", () =>
        callWpWithRetry("preflight create draft", () =>
          wp.createPost(sites.mainSite.id, {
            title: `local2wp.com preflight ${new Date().toISOString()}`,
            content: "<p>preflight</p>",
            status: "draft",
            tags: []
          })
        )
      );
      const postId = parsePostId(created);
      if (!postId) {
        throw new Error("preflight draft created without post id");
      }
      await withHeartbeatLog("post_stage: wpcom preflight delete draft", () =>
        callWpWithRetry("preflight delete draft", () => wp.deletePost(sites.mainSite.id, postId))
      );
      if (logInfo) logInfo("wpcom_preflight: write access ok.");
    } catch (error) {
      const msg = String(error?.message || error || "");
      if (/403|permission|forbidden|access denied|not authorized/i.test(msg)) {
        throw new Error(
          `WordPress.com preflight failed: no write access to site ${sites.mainSite.id}. ` +
            `Ensure WP_COM_USERNAME + WP_COM_APP_PASSWORD belong to a user with Editor/Admin role on target site(s).`
        );
      }
      throw new Error(`WordPress.com preflight failed: ${msg}`);
    }
  }

  async function resetBeforePosting(ctx = {}) {
    if (!wpReset) return;
    if (ctx.DRY_RUN) {
      if (logInfo) logInfo("wpcom_reset: requested but DRY_RUN=true; skipping site wipe.");
      return;
    }
    if (typeof ctx.resetPairPostingState !== "function") {
      throw new Error("wpcom_reset requires resetPairPostingState helper.");
    }
    const sites = await ensureResolvedSites();
    const wp = getWpComClient();
    if (logInfo) logInfo("wpcom_reset: deleting all existing main-site posts...");
    const allPosts = await listAllPostsMainSite(sites.mainSite.id);
    for (const post of allPosts) {
      const postId = parsePostId(post);
      if (!postId) continue;
      await withHeartbeatLog(`post_stage: wpcom delete post ${postId}`, () =>
        callWpWithRetry(`delete post ${postId}`, () => wp.deletePost(sites.mainSite.id, postId))
      );
    }
    if (logInfo) logInfo(`wpcom_reset: deleted posts=${allPosts.length}`);

    const mediaSites = Array.from(
      new Set(
        (sites.mediaPool || [])
          .map((x) => String(x?.id || "").trim())
          .filter(Boolean)
      )
    );
    if (mediaSites.length > 0) {
      if (logInfo) {
        logInfo(`wpcom_reset: deleting media from site pool ${mediaSites.join(",")}...`);
      }
      let totalDeletedMedia = 0;
      for (const mediaSiteId of mediaSites) {
        const mediaItems = await listAllMediaForSite(mediaSiteId);
        let deletedOnSite = 0;
        for (const mediaItem of mediaItems) {
          const mediaId = parseMediaId(mediaItem);
          if (!mediaId) continue;
          await withHeartbeatLog(`post_stage: wpcom delete media ${mediaId} @${mediaSiteId}`, () =>
            callWpWithRetry(`delete media ${mediaId}@${mediaSiteId}`, () =>
              wp.deleteMedia(mediaSiteId, mediaId)
            )
          );
          deletedOnSite += 1;
          totalDeletedMedia += 1;
        }
        if (logInfo) {
          logInfo(`wpcom_reset: deleted media on site ${mediaSiteId} => ${deletedOnSite}`);
        }
      }
      if (logInfo) {
        logInfo(`wpcom_reset: deleted media total=${totalDeletedMedia}`);
      }
    }

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
    if (logInfo) logInfo("wpcom_reset: cleared posted-state mappings for current source->wp pair.");
  }

  async function postMessages(input = {}) {
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const cleanedTextById = input.cleanedTextById instanceof Map ? input.cleanedTextById : new Map();
    const downloadedMediaById =
      input.downloadedMediaById instanceof Map ? input.downloadedMediaById : new Map();
    const archiveDb = input.archiveDb;
    const archivePairKey = String(input.archivePairKey || "");

    if (!messages.length) {
      return { sentCount: 0, mappingChanged: 0, sentSourceIds: [] };
    }

    const wp = getWpComClient();
    const sites = await ensureResolvedSites();
    const primarySourceId = Number.parseInt(String(messages[0]?.id || 0), 10);
    const archiveRow = getPostArchiveRow(archiveDb, archivePairKey, primarySourceId) || {};
    const title = extractTitleFromPostTxt(archiveRow.postTxtAbsPath, archiveRow.title || "Untitled");

    const uploadedMedia = [];
    const failedUploads = [];
    for (const message of messages) {
      const sourceId = Number.parseInt(String(message?.id || 0), 10);
      if (!Number.isInteger(sourceId) || sourceId <= 0) continue;
      const mediaPath = String(downloadedMediaById.get(sourceId) || "").trim();
      if (!mediaPath || !fs.existsSync(mediaPath)) continue;
      try {
        uploadedMedia.push(await uploadMediaToPool(mediaPath));
      } catch (error) {
        const fileName = path.basename(mediaPath);
        const errorText = String(error?.message || error || "upload failed");
        failedUploads.push({ fileName, error: errorText });
        if (logInfo) {
          logInfo(`post_stage: wpcom media skipped ${fileName} (${errorText})`);
        }
      }
    }

    const text = collectCombinedText(messages, cleanedTextById);
    const textHtml = normalizeTextToHtml(text);
    const mediaHtml = buildMediaHtml(uploadedMedia);
    const failedMediaHtml = buildFailedMediaNoteHtml(failedUploads);
    const contentParts = [];
    if (mediaHtml) contentParts.push(mediaHtml);
    if (failedMediaHtml) contentParts.push(failedMediaHtml);
    if (textHtml) contentParts.push(`<p>${textHtml}</p>`);
    const contentHtml = contentParts.join("\n\n");
    const payload = await withHeartbeatLog(
      `post_stage: wpcom create post #${messages[0].id}${messages.length > 1 ? `-#${messages[messages.length - 1].id}` : ""}`,
      () =>
        callWpWithRetry("create wp post", () =>
          wp.createPost(sites.mainSite.id, {
            title,
            content: contentHtml,
            status: "publish",
            tags: wpTags
          })
        )
    );

    const sentSourceIds = messages
      .map((m) => Number.parseInt(String(m?.id || 0), 10))
      .filter((id) => Number.isInteger(id) && id > 0);
    return {
      sentCount: sentSourceIds.length,
      mappingChanged: 0,
      sentSourceIds,
      primaryDestinationPermalink: parsePostPermalink(payload)
    };
  }

  return {
    key: "wp-com",
    label: "wordpress-com",
    assertPostMode,
    preflightBeforeRun,
    resetBeforePosting,
    postMessages
  };
}

module.exports = {
  createWpComTargetAdapter
};
