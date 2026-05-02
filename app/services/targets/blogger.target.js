"use strict";

const fs = require("fs");
const path = require("path");

function createBloggerTargetAdapter(deps = {}) {
  const getBloggerClient = deps.getBloggerClient;
  const withHeartbeatLog = deps.withHeartbeatLog;
  const sleepWithAdaptivePacing = deps.sleepWithAdaptivePacing;
  const logInfo = typeof deps.logInfo === "function" ? deps.logInfo : null;
  const blogIdInput = String(deps.blogId || "").trim();
  const blogUrlInput = String(deps.blogUrl || "").trim();
  const blogReset = !!deps.blogReset;
  const blogTags = Array.isArray(deps.blogTags) ? deps.blogTags : [];
  const getPostArchiveRow = deps.getPostArchiveRow;
  const bloggerRetryMax = Math.max(0, Number.parseInt(String(deps.bloggerRetryMax || 3), 10) || 3);
  const bloggerRetryWaitRange = deps.bloggerRetryWaitRange || { min: 2500, max: 6000 };

  if (typeof getBloggerClient !== "function") {
    throw new Error("createBloggerTargetAdapter: getBloggerClient is required");
  }
  if (typeof withHeartbeatLog !== "function") {
    throw new Error("createBloggerTargetAdapter: withHeartbeatLog is required");
  }
  if (typeof getPostArchiveRow !== "function") {
    throw new Error("createBloggerTargetAdapter: getPostArchiveRow is required");
  }

  let resolvedBlog = null;

  function assertPostMode(postMode) {
    const mode = String(postMode || "").toLowerCase();
    if (mode !== "own-post") {
      throw new Error(
        `Unsupported POST_MODE "${postMode}" for blogger target. Use POST_MODE=own-post.`
      );
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

  function isTransientBloggerError(error) {
    const status = extractHttpStatusFromError(error);
    const msg = String(error?.message || error || "").toLowerCase();
    if (status === 429 || status >= 500) return true;
    if (status === 403 && /(ratelimit|quota|userratelimit|dailylimit|exceeded)/i.test(msg)) {
      return true;
    }
    if (/etimedout|econnreset|eai_again|network|fetch failed|socket|temporar/i.test(msg)) {
      return true;
    }
    return false;
  }

  async function waitBeforeRetry(reason, attemptNo) {
    const jitterMs = randomIntInclusive(bloggerRetryWaitRange.min, bloggerRetryWaitRange.max);
    const scale = Math.max(1, attemptNo);
    const waitMs = jitterMs * scale;
    if (typeof sleepWithAdaptivePacing === "function") {
      await sleepWithAdaptivePacing("blogger", `${reason} retry ${attemptNo}`);
    }
    if (logInfo) {
      logInfo(`post_stage: blogger retry ${attemptNo}/${bloggerRetryMax} -> waiting ${waitMs}ms`);
    }
    await sleep(waitMs);
  }

  async function callBloggerWithRetry(label, action) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await action();
      } catch (error) {
        if (attempt > bloggerRetryMax || !isTransientBloggerError(error)) {
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
      ".wav": "audio/wav"
    };
    return map[ext] || "application/octet-stream";
  }

  function formatBytes(bytes) {
    const n = Math.max(0, Number(bytes || 0));
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function buildMediaHtml(messages, downloadedMediaById) {
    const imageBlocks = [];
    const attachmentBlocks = [];
    for (const message of messages) {
      const sourceId = Number.parseInt(String(message?.id || 0), 10);
      if (!Number.isInteger(sourceId) || sourceId <= 0) continue;
      const mediaPath = String(downloadedMediaById.get(sourceId) || "").trim();
      if (!mediaPath || !fs.existsSync(mediaPath)) continue;
      const bytes = fs.readFileSync(mediaPath);
      const mimeType = mimeTypeFromPath(mediaPath);
      const fileName = path.basename(mediaPath);
      if (mimeType.startsWith("image/")) {
        const dataUri = `data:${mimeType};base64,${bytes.toString("base64")}`;
        imageBlocks.push(
          `<p><img src="${dataUri}" alt="${escapeHtml(fileName)}" style="max-width:100%;height:auto;border-radius:8px;" /></p>`
        );
      } else {
        attachmentBlocks.push(
          `<p><strong>Attachment:</strong> ${escapeHtml(fileName)} (${escapeHtml(
            mimeType
          )}, ${formatBytes(bytes.length)})</p>`
        );
      }
    }
    return [...imageBlocks, ...attachmentBlocks].join("\n");
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

  function buildShareButtonHtml(permalink) {
    const url = String(permalink || "").trim();
    if (!url) return "";
    return [
      "<hr>",
      `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Share this post</a></p>`
    ].join("\n");
  }

  async function ensureResolvedBlog() {
    if (resolvedBlog) return resolvedBlog;
    const bloggerClient = getBloggerClient();
    resolvedBlog = await withHeartbeatLog("post_stage: blogger resolve blog", () =>
      callBloggerWithRetry("resolve blog", () =>
        bloggerClient.resolveBlog({
          blogId: blogIdInput,
          blogUrl: blogUrlInput
        })
      )
    );
    if (!resolvedBlog?.id) {
      throw new Error("Could not resolve Blogger blog id from BLOGGER_BLOG_ID/BLOGGER_BLOG_URL.");
    }
    if (logInfo) {
      const name = String(resolvedBlog?.name || "").trim();
      const url = String(resolvedBlog?.url || "").trim();
      logInfo(`post_stage: blogger target ${resolvedBlog.id}${name ? ` (${name})` : ""}${url ? ` ${url}` : ""}`);
    }
    return resolvedBlog;
  }

  async function resetBeforePosting(ctx = {}) {
    if (!blogReset) return;
    const dryRun = !!ctx.DRY_RUN;
    const resetPairPostingState = ctx.resetPairPostingState;
    const persistArchiveState = ctx.persistArchiveState;
    const processedSourceIds = ctx.processedSourceIds;
    const linkRewriteState = ctx.linkRewriteState;
    const archiveDb = ctx.archiveDb;
    const pairKey = String(ctx.pairKey || "");

    if (dryRun) {
      if (logInfo) logInfo("blogger_reset: requested but DRY_RUN=true; skipping blog wipe.");
      return;
    }
    if (typeof resetPairPostingState !== "function") {
      throw new Error("blogger_reset requires resetPairPostingState helper.");
    }

    const blog = await ensureResolvedBlog();
    const bloggerClient = getBloggerClient();
    if (logInfo) logInfo("blogger_reset: deleting all existing blog posts...");
    const allPosts = await withHeartbeatLog("post_stage: blogger list existing posts", () =>
      callBloggerWithRetry("list existing posts", () => bloggerClient.listAllPosts(blog.id))
    );
    for (const post of allPosts) {
      const postId = String(post?.id || "").trim();
      if (!postId) continue;
      await withHeartbeatLog(`post_stage: blogger delete post ${postId}`, () =>
        callBloggerWithRetry(`delete post ${postId}`, () => bloggerClient.deletePost(blog.id, postId))
      );
    }
    if (logInfo) logInfo(`blogger_reset: deleted posts=${allPosts.length}`);

    resetPairPostingState(archiveDb, pairKey);
    if (typeof persistArchiveState === "function") {
      persistArchiveState();
    }
    if (processedSourceIds && typeof processedSourceIds.clear === "function") {
      processedSourceIds.clear();
    }
    if (linkRewriteState?.sourceToDestinationId && typeof linkRewriteState.sourceToDestinationId.clear === "function") {
      linkRewriteState.sourceToDestinationId.clear();
    }
    if (logInfo) logInfo("blogger_reset: cleared posted-state mappings for current source->blog pair.");
  }

  async function preflightBeforeRun(ctx = {}) {
    const dryRun = !!ctx.DRY_RUN;
    if (dryRun) {
      if (logInfo) logInfo("blogger_preflight: DRY_RUN=true; skipping write-check.");
      return;
    }
    const blog = await ensureResolvedBlog();
    const bloggerClient = getBloggerClient();
    const probeTitle = `local2blogger preflight ${new Date().toISOString()}`;
    let created = null;
    try {
      if (logInfo) logInfo("blogger_preflight: checking write access...");
      created = await withHeartbeatLog("post_stage: blogger preflight create draft", () =>
        callBloggerWithRetry("preflight create draft", () =>
          bloggerClient.createPost(blog.id, {
            title: probeTitle,
            content: "<p>preflight</p>",
            labels: [],
            isDraft: true
          })
        )
      );
      const postId = String(created?.id || "").trim();
      if (!postId) {
        throw new Error("preflight draft created without post id");
      }
      await withHeartbeatLog("post_stage: blogger preflight delete draft", () =>
        callBloggerWithRetry("preflight delete draft", () => bloggerClient.deletePost(blog.id, postId))
      );
      if (logInfo) logInfo("blogger_preflight: write access ok.");
    } catch (error) {
      const msg = String(error?.message || error || "");
      if (/403|permission|forbidden|access denied/i.test(msg)) {
        throw new Error(
          `Blogger preflight failed: no write access to blog ${blog.id}. ` +
            `Use a refresh token from an account that is Author/Admin of this blog.`
        );
      }
      throw new Error(`Blogger preflight failed: ${msg}`);
    }
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

    const blog = await ensureResolvedBlog();
    const bloggerClient = getBloggerClient();
    const primarySourceId = Number.parseInt(String(messages[0]?.id || 0), 10);
    const archiveRow = getPostArchiveRow(archiveDb, archivePairKey, primarySourceId) || {};
    const title = extractTitleFromPostTxt(archiveRow.postTxtAbsPath, archiveRow.title || "Untitled");
    const combinedText = buildCombinedText(messages, cleanedTextById);
    const mediaHtml = buildMediaHtml(messages, downloadedMediaById);
    const textHtml = normalizeTextToHtml(combinedText);
    const contentSections = [];
    if (mediaHtml) contentSections.push(mediaHtml);
    if (textHtml) contentSections.push(`<p>${textHtml}</p>`);
    const initialContent = contentSections.join("\n\n");

    const labels = blogTags.slice();
    const rangeText = (() => {
      const first = Number.parseInt(String(messages[0]?.id || 0), 10);
      const last = Number.parseInt(String(messages[messages.length - 1]?.id || 0), 10);
      if (!Number.isInteger(first) || !Number.isInteger(last)) return "unknown";
      return first === last ? `#${first}` : `#${first}-#${last}`;
    })();

    const created = await withHeartbeatLog(`post_stage: blogger create ${rangeText}`, () =>
      callBloggerWithRetry(`create ${rangeText}`, () =>
        bloggerClient.createPost(blog.id, {
          title,
          content: initialContent,
          labels,
          isDraft: false
        })
      )
    );
    const permalink = String(created?.url || "").trim();
    if (permalink) {
      const withShare = [initialContent, buildShareButtonHtml(permalink)]
        .filter((x) => String(x || "").trim())
        .join("\n\n");
      await withHeartbeatLog(`post_stage: blogger add share link ${rangeText}`, () =>
        callBloggerWithRetry(`add share link ${rangeText}`, () =>
          bloggerClient.updatePost(blog.id, created.id, {
            title,
            content: withShare,
            labels,
            publish: true
          })
        )
      );
    }

    const sentSourceIds = messages
      .map((m) => Number.parseInt(String(m?.id || 0), 10))
      .filter((x) => Number.isInteger(x) && x > 0);
    return {
      sentCount: sentSourceIds.length,
      mappingChanged: 0,
      sentSourceIds
    };
  }

  return {
    key: "blogger",
    label: "blogger",
    assertPostMode,
    postMessages,
    preflightBeforeRun,
    resetBeforePosting
  };
}

module.exports = {
  createBloggerTargetAdapter
};
