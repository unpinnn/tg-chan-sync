"use strict";

function createXWebTargetAdapter(deps = {}) {
  const getXWebClient = deps.getXWebClient;
  const withHeartbeatLog = deps.withHeartbeatLog;
  const logInfo = typeof deps.logInfo === "function" ? deps.logInfo : null;
  const maxTextLength = Math.max(
    40,
    Math.min(280, Number.parseInt(String(deps.maxTextLength || 260), 10) || 260)
  );

  if (typeof getXWebClient !== "function") {
    throw new Error("createXWebTargetAdapter: getXWebClient is required");
  }
  if (typeof withHeartbeatLog !== "function") {
    throw new Error("createXWebTargetAdapter: withHeartbeatLog is required");
  }

  function assertPostMode(postMode) {
    const mode = String(postMode || "").toLowerCase();
    if (mode !== "own-post") {
      throw new Error(
        `Unsupported POST_MODE "${postMode}" for x-web target. Use POST_MODE=own-post.`
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
    return `post_stage: x-web ${String(text || "").trim()}`.trim();
  }

  function chunkArray(values = [], size = 4) {
    const out = [];
    for (let i = 0; i < values.length; i += size) {
      out.push(values.slice(i, i + size));
    }
    return out;
  }

  function buildGroupedText(messages, cleanedTextById) {
    const parts = [];
    for (const message of messages) {
      const sourceId = Number.parseInt(String(message?.id || 0), 10);
      if (!Number.isInteger(sourceId) || sourceId <= 0) continue;
      const value = String(cleanedTextById.get(sourceId) || "");
      if (!value.trim()) continue;
      parts.push(value);
    }
    return parts.join("\n\n");
  }

  function isAlbumLikeGroup(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return false;
    const mediaMessages = messages.filter((message) => !!message?.media);
    if (mediaMessages.length <= 1) return false;
    const firstGroupedId = String(mediaMessages[0]?.groupedId ?? "").trim();
    if (!firstGroupedId) return true;
    return mediaMessages.every((message) => String(message?.groupedId ?? "").trim() === firstGroupedId);
  }

  function mediaPathsForMessages(messages, downloadedMediaById) {
    const out = [];
    for (const message of messages) {
      const sourceId = Number.parseInt(String(message?.id || 0), 10);
      if (!Number.isInteger(sourceId) || sourceId <= 0) continue;
      const mediaPath = String(downloadedMediaById.get(sourceId) || "").trim();
      if (!mediaPath) continue;
      out.push(mediaPath);
    }
    return out;
  }

  async function postGroupedMediaMessages(webClient, input = {}) {
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const cleanedTextById = input.cleanedTextById || new Map();
    const downloadedMediaById = input.downloadedMediaById || new Map();
    let threadRootId = String(input.threadRootId || "");
    let replyToId = String(input.replyToIdInitial || "");
    const sourceIds = [];
    for (const message of messages) {
      const sourceId = Number.parseInt(String(message?.id || 0), 10);
      if (Number.isInteger(sourceId) && sourceId > 0) sourceIds.push(sourceId);
    }
    const groupedText = buildGroupedText(messages, cleanedTextById);
    const textChunks = splitTextForX(groupedText, maxTextLength);
    const mediaGroups = chunkArray(mediaPathsForMessages(messages, downloadedMediaById), 4);

    let postedCount = 0;
    for (let idx = 0; idx < mediaGroups.length; idx += 1) {
      const mediaSet = mediaGroups[idx];
      const text = textChunks.length > 0 ? String(textChunks.shift() || "") : "";
      const stage = stageLine(
        `posting grouped media ${idx + 1}/${mediaGroups.length} #${sourceIds[0]}-#${
          sourceIds[sourceIds.length - 1]
        }`
      );
      if (logInfo) logInfo(stage);
      try {
        const sentId = await withHeartbeatLog(stage, () =>
          webClient.sendPost({
            mediaPaths: mediaSet,
            replyToId: replyToId || threadRootId,
            text
          })
        );
        const postId = String(sentId || "").trim();
        if (!postId) continue;
        if (!threadRootId) threadRootId = postId;
        replyToId = postId;
        postedCount += 1;
      } catch (error) {
        // Fallback: post each media item separately in the same thread.
        if (logInfo) {
          logInfo(
            stageLine(
              `grouped batch fallback ${idx + 1}/${mediaGroups.length} -> single media posts (${
                error?.message || error
              })`
            )
          );
        }
        for (let mediaIdx = 0; mediaIdx < mediaSet.length; mediaIdx += 1) {
          const singleText = mediaIdx === 0 ? text : "";
          const fallbackStage = stageLine(
            `posting grouped fallback media ${mediaIdx + 1}/${mediaSet.length} #${sourceIds[0]}-#${
              sourceIds[sourceIds.length - 1]
            }`
          );
          const sentId = await withHeartbeatLog(fallbackStage, () =>
            webClient.sendPost({
              mediaPath: mediaSet[mediaIdx],
              replyToId: replyToId || threadRootId,
              text: singleText
            })
          );
          const postId = String(sentId || "").trim();
          if (!postId) continue;
          if (!threadRootId) threadRootId = postId;
          replyToId = postId;
          postedCount += 1;
        }
      }
    }

    let chunkIndex = 0;
    while (textChunks.length > 0) {
      chunkIndex += 1;
      const text = String(textChunks.shift() || "");
      if (!text.trim()) continue;
      const stage = stageLine(
        `posting grouped text ${chunkIndex} #${sourceIds[0]}-#${sourceIds[sourceIds.length - 1]}`
      );
      if (logInfo) logInfo(stage);
      const sentId = await withHeartbeatLog(stage, () =>
        webClient.sendPost({
          replyToId: replyToId || threadRootId,
          text
        })
      );
      const postId = String(sentId || "").trim();
      if (!postId) continue;
      if (!threadRootId) threadRootId = postId;
      replyToId = postId;
      postedCount += 1;
    }

    return {
      sentCount: postedCount > 0 ? messages.length : 0,
      sentSourceIds: postedCount > 0 ? sourceIds : []
    };
  }

  async function postOneMessage(webClient, input = {}) {
    const message = input.message;
    const cleanedTextById = input.cleanedTextById;
    const downloadedMediaById = input.downloadedMediaById;
    const threadRootId = String(input.threadRootId || "");
    const replyToIdInitial = String(input.replyToIdInitial || "");

    const sourceId = Number.parseInt(String(message?.id || 0), 10);
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return { sourceId: 0, rootPostId: "", lastPostId: "", sentCount: 0 };
    }
    const mediaPath = downloadedMediaById.get(sourceId) || "";
    const textValue = cleanedTextById.get(sourceId) || "";
    const chunks = splitTextForX(textValue, maxTextLength);

    let rootPostId = "";
    let lastPostId = replyToIdInitial;
    let sentCount = 0;
    for (let idx = 0; idx < chunks.length; idx += 1) {
      const chunkText = String(chunks[idx] || "");
      const mediaForChunk = idx === 0 ? mediaPath : "";
      if (!chunkText && !mediaForChunk) {
        continue;
      }
      const replyTo = lastPostId || threadRootId;
      const stage = stageLine(
        `posting #${sourceId}${chunks.length > 1 ? ` part ${idx + 1}/${chunks.length}` : ""}`
      );
      if (logInfo) logInfo(stage);
      const sentId = await withHeartbeatLog(stage, () =>
        webClient.sendPost({
          mediaPath: mediaForChunk,
          replyToId: replyTo,
          text: chunkText
        })
      );
      const postId = String(sentId || "").trim();
      if (!postId) continue;
      if (!rootPostId) rootPostId = postId;
      lastPostId = postId;
      sentCount += 1;
    }
    return { sourceId, rootPostId, lastPostId, sentCount };
  }

  async function postMessages(input = {}) {
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const cleanedTextById = input.cleanedTextById || new Map();
    const downloadedMediaById = input.downloadedMediaById || new Map();
    if (!messages.length) {
      return { sentCount: 0, mappingChanged: 0, sentSourceIds: [] };
    }

    const webClient = await getXWebClient();
    if (isAlbumLikeGroup(messages)) {
      const groupedResult = await postGroupedMediaMessages(webClient, {
        messages,
        cleanedTextById,
        downloadedMediaById
      });
      return {
        sentCount: groupedResult.sentCount,
        mappingChanged: 0,
        sentSourceIds: groupedResult.sentSourceIds
      };
    }

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
      const posted = await postOneMessage(webClient, {
        message,
        cleanedTextById,
        downloadedMediaById,
        threadRootId,
        replyToIdInitial: replyToId
      });
      sentCount += posted.sentCount;
      if (posted.sourceId > 0 && posted.rootPostId) {
        sentSourceIds.push(posted.sourceId);
      }
      if (posted.rootPostId && !threadRootId) {
        threadRootId = posted.rootPostId;
      }
      if (posted.lastPostId) {
        replyToId = posted.lastPostId;
      }
    }

    return {
      sentCount,
      mappingChanged: 0,
      sentSourceIds
    };
  }

  return {
    key: "x-web",
    label: "x-web-browser",
    assertPostMode,
    postMessages
  };
}

module.exports = {
  createXWebTargetAdapter
};
