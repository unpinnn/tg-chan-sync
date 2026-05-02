"use strict";

function createTelegramTargetAdapter(deps = {}) {
  const isGroupedPost = deps.isGroupedPost;
  const withHeartbeatLog = deps.withHeartbeatLog;
  const logInfo = deps.logInfo;
  const forwardMessage = deps.forwardMessage;
  const forwardMessageGroup = deps.forwardMessageGroup;
  const reuploadGroupedMedia = deps.reuploadGroupedMedia;
  const reuploadMessageMedia = deps.reuploadMessageMedia;
  const sendTextMessage = deps.sendTextMessage;
  const rememberMessageIdMappings = deps.rememberMessageIdMappings;

  function assertPostMode(postMode) {
    const mode = String(postMode || "").toLowerCase();
    if (!["own-post", "forwarded"].includes(mode)) {
      throw new Error(`Unsupported POST_MODE "${postMode}" for telegram target.`);
    }
  }

  async function postMessages(ctx = {}) {
    const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
    const cleanedTextById = ctx.cleanedTextById instanceof Map ? ctx.cleanedTextById : new Map();
    const postMode = String(ctx.postMode || "").toLowerCase();
    const client = ctx.client;
    const source = ctx.source;
    const destination = ctx.destination;
    const downloadedMediaById =
      ctx.downloadedMediaById instanceof Map ? ctx.downloadedMediaById : new Map();
    const linkRewriteState = ctx.linkRewriteState;
    const suppressPrimaryOverflowText = !!ctx.suppressPrimaryOverflowText;

    let sentCount = 0;
    let mappingChanged = 0;
    const sentSourceIds = [];
    const grouped = isGroupedPost(messages);

    if (postMode === "forwarded") {
      if (grouped) {
        logInfo(`post_stage: forwarding grouped #${messages[0].id}-#${messages[messages.length - 1].id}`);
        const ok = await withHeartbeatLog(
          `post_stage: forwarding grouped #${messages[0].id}-#${messages[messages.length - 1].id}`,
          () => forwardMessageGroup(client, source, destination, messages)
        );
        sentCount = ok ? messages.length : 0;
        if (ok) sentSourceIds.push(...messages.map((m) => m.id));
      } else {
        for (const message of messages) {
          logInfo(`post_stage: forwarding #${message.id}`);
          const ok = await withHeartbeatLog(
            `post_stage: forwarding #${message.id}`,
            () => forwardMessage(client, source, destination, message)
          );
          if (ok) {
            sentCount += 1;
            sentSourceIds.push(message.id);
          }
        }
      }
      return { mappingChanged, sentCount, sentSourceIds };
    }

    if (grouped && messages.every((m) => !!m.media)) {
      const captions = messages.map((m) => cleanedTextById.get(m.id) || "");
      const suppressOverflowByIndex = suppressPrimaryOverflowText ? new Set([0]) : new Set();
      logInfo(`post_stage: uploading grouped #${messages[0].id}-#${messages[messages.length - 1].id}`);
      const sentMessages = await withHeartbeatLog(
        `post_stage: uploading grouped #${messages[0].id}-#${messages[messages.length - 1].id}`,
        () =>
          reuploadGroupedMedia(client, destination, messages, downloadedMediaById, captions, {
            suppressOverflowByIndex
          })
      );
      mappingChanged += rememberMessageIdMappings(messages, sentMessages, linkRewriteState);
      sentCount = sentMessages.length;
      for (let i = 0; i < sentMessages.length && i < messages.length; i += 1) {
        sentSourceIds.push(messages[i].id);
      }
      return { mappingChanged, sentCount, sentSourceIds };
    }

    for (const message of messages) {
      const cleanedText = cleanedTextById.get(message.id) || "";
      const canReuseEntities = cleanedText === (message.message || "");
      const entitiesToSend = canReuseEntities ? message.entities : undefined;

      let sentMessage = null;
      if (message.media) {
        logInfo(`post_stage: uploading #${message.id}`);
        sentMessage = await withHeartbeatLog(
          `post_stage: uploading #${message.id}`,
          () =>
            reuploadMessageMedia(
              client,
              destination,
              message,
              downloadedMediaById.get(message.id),
              cleanedText,
              entitiesToSend,
              { suppressOverflowText: suppressPrimaryOverflowText && message.id === messages[0].id }
            )
        );
      } else {
        logInfo(`post_stage: sending text #${message.id}`);
        sentMessage = await withHeartbeatLog(
          `post_stage: sending text #${message.id}`,
          () => sendTextMessage(client, destination, message, cleanedText, entitiesToSend)
        );
      }
      if (sentMessage) {
        mappingChanged += rememberMessageIdMappings([message], [sentMessage], linkRewriteState);
        sentCount += 1;
        sentSourceIds.push(message.id);
      }
    }

    return { mappingChanged, sentCount, sentSourceIds };
  }

  return {
    key: "dest",
    label: "telegram-destination",
    assertPostMode,
    postMessages
  };
}

module.exports = {
  createTelegramTargetAdapter
};
