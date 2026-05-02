"use strict";

const path = require("path");

function createXTargetAdapter(deps = {}) {
  const getXClient = deps.getXClient;
  const withHeartbeatLog = deps.withHeartbeatLog;
  const logInfo = typeof deps.logInfo === "function" ? deps.logInfo : null;
  const maxTextLength = Math.max(
    40,
    Math.min(280, Number.parseInt(String(deps.maxTextLength || 260), 10) || 260)
  );

  if (typeof getXClient !== "function") {
    throw new Error("createXTargetAdapter: getXClient is required");
  }
  if (typeof withHeartbeatLog !== "function") {
    throw new Error("createXTargetAdapter: withHeartbeatLog is required");
  }

  function assertPostMode(postMode) {
    const mode = String(postMode || "").toLowerCase();
    if (mode !== "own-post") {
      throw new Error(
        `Unsupported POST_MODE "${postMode}" for x-twitter target. Use POST_MODE=own-post.`
      );
    }
  }

  function splitTextForX(inputText, maxLen = 280) {
    const text = String(inputText || "").replace(/\r\n/g, "\n");
    if (!text.trim()) return [""];
    if (text.length <= maxLen) return [text];
    const out = [];
    let rest = text;
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf("\n", maxLen);
      if (cut < Math.floor(maxLen * 0.5)) {
        cut = rest.lastIndexOf(" ", maxLen);
      }
      if (cut < Math.floor(maxLen * 0.4)) {
        cut = maxLen;
      }
      let chunk = rest.slice(0, cut);
      if (!chunk.trim()) {
        chunk = rest.slice(0, maxLen);
        cut = maxLen;
      }
      out.push(chunk);
      rest = rest.slice(cut);
      if (rest.startsWith("\n") && out[out.length - 1].endsWith("\n")) {
        rest = rest.slice(1);
      }
    }
    if (rest.length > 0) {
      out.push(rest);
    }
    return out.filter((x, idx) => idx === 0 || x.trim().length > 0);
  }

  function stageLine(text) {
    return `post_stage: x ${String(text || "").trim()}`.trim();
  }

  function guessMimeType(filePath) {
    const ext = String(path.extname(String(filePath || "")).toLowerCase());
    const map = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg"
    };
    return map[ext] || "application/octet-stream";
  }

  async function uploadMediaIfAny(xClient, mediaPath, stageLabel) {
    const pathText = String(mediaPath || "").trim();
    if (!pathText) return null;
    const mimeType = guessMimeType(pathText);
    if (logInfo) logInfo(stageLabel);
    const mediaId = await withHeartbeatLog(stageLabel, () =>
      xClient.v1.uploadMedia(pathText, { mimeType })
    );
    return String(mediaId || "").trim() || null;
  }

  async function sendTweet(xClient, payload, stageLabel) {
    if (logInfo) logInfo(stageLabel);
    const result = await withHeartbeatLog(stageLabel, () => xClient.v2.tweet(payload));
    const tweetId = String(result?.data?.id || "").trim();
    return tweetId || "";
  }

  async function postOneMessage(xClient, input = {}) {
    const message = input.message;
    const cleanedTextById = input.cleanedTextById;
    const downloadedMediaById = input.downloadedMediaById;
    const threadRootId = String(input.threadRootId || "");
    const replyToIdInitial = String(input.replyToIdInitial || "");

    const sourceId = Number.parseInt(String(message?.id || 0), 10);
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return { sourceId: 0, rootTweetId: "", lastTweetId: "", sentCount: 0 };
    }
    const mediaPath = downloadedMediaById.get(sourceId) || "";
    const mediaId = await uploadMediaIfAny(
      xClient,
      mediaPath,
      stageLine(`uploading media #${sourceId}`)
    );
    const textValue = cleanedTextById.get(sourceId) || "";
    const chunks = splitTextForX(textValue, maxTextLength);

    let rootTweetId = "";
    let lastTweetId = replyToIdInitial;
    let sentCount = 0;
    for (let idx = 0; idx < chunks.length; idx += 1) {
      const chunkText = String(chunks[idx] || "");
      const payload = {};
      if (chunkText) {
        payload.text = chunkText;
      }
      if (idx === 0 && mediaId) {
        payload.media = { media_ids: [mediaId] };
      }
      const replyTo = lastTweetId || threadRootId;
      if (replyTo) {
        payload.reply = { in_reply_to_tweet_id: replyTo };
      }

      if (!payload.text && !payload.media) {
        continue;
      }

      const sentId = await sendTweet(
        xClient,
        payload,
        stageLine(
          `tweeting #${sourceId}${chunks.length > 1 ? ` part ${idx + 1}/${chunks.length}` : ""}`
        )
      );
      if (!sentId) continue;
      if (!rootTweetId) {
        rootTweetId = sentId;
      }
      lastTweetId = sentId;
      sentCount += 1;
    }
    return { sourceId, rootTweetId, lastTweetId, sentCount };
  }

  async function postMessages(input = {}) {
    const xClient = getXClient();
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const cleanedTextById = input.cleanedTextById || new Map();
    const downloadedMediaById = input.downloadedMediaById || new Map();
    if (!messages.length) {
      return { sentCount: 0, mappingChanged: 0, sentSourceIds: [] };
    }

    let mappingChanged = 0;
    let sentCount = 0;
    const sentSourceIds = [];

    let threadRootId = "";
    let replyToId = "";
    const firstId = Number.parseInt(String(messages[0]?.id || 0), 10);
    const lastId = Number.parseInt(String(messages[messages.length - 1]?.id || 0), 10);
    if (logInfo && Number.isInteger(firstId) && Number.isInteger(lastId)) {
      const rangeText = firstId === lastId ? `#${firstId}` : `#${firstId}-#${lastId}`;
      logInfo(stageLine(`posting thread ${rangeText}`));
    }

    for (const message of messages) {
      const posted = await postOneMessage(xClient, {
        message,
        cleanedTextById,
        downloadedMediaById,
        threadRootId,
        replyToIdInitial: replyToId
      });
      sentCount += posted.sentCount;
      if (posted.sourceId > 0 && posted.rootTweetId) {
        sentSourceIds.push(posted.sourceId);
      }
      if (posted.rootTweetId && !threadRootId) {
        threadRootId = posted.rootTweetId;
      }
      if (posted.lastTweetId) {
        replyToId = posted.lastTweetId;
      }
    }

    return {
      sentCount,
      mappingChanged,
      sentSourceIds
    };
  }

  return {
    key: "x",
    label: "x-twitter",
    assertPostMode,
    postMessages
  };
}

module.exports = {
  createXTargetAdapter
};
