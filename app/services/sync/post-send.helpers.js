const fs = require("fs");

function createPostSendHelpers(deps = {}) {
  const DRY_RUN = deps.DRY_RUN;
  const MAX_MEDIA_CAPTION_LENGTH = deps.MAX_MEDIA_CAPTION_LENGTH;
  const MAX_TEXT_MESSAGE_LENGTH = deps.MAX_TEXT_MESSAGE_LENGTH;
  const withFloodWaitRetry = deps.withFloodWaitRetry;
  const downloadMessageMedia = deps.downloadMessageMedia;
  const prepareUploadFileInput = deps.prepareUploadFileInput;
  const shouldForceDocumentForReupload = deps.shouldForceDocumentForReupload;

  if (typeof withFloodWaitRetry !== "function") {
    throw new Error("createPostSendHelpers: withFloodWaitRetry is required");
  }
  if (typeof downloadMessageMedia !== "function") {
    throw new Error("createPostSendHelpers: downloadMessageMedia is required");
  }
  if (typeof prepareUploadFileInput !== "function") {
    throw new Error("createPostSendHelpers: prepareUploadFileInput is required");
  }
  if (typeof shouldForceDocumentForReupload !== "function") {
    throw new Error("createPostSendHelpers: shouldForceDocumentForReupload is required");
  }

  function preferredSplitIndex(value, maxLen, minRatio = 0.6) {
    const text = String(value || "");
    const limit = Math.max(1, Number(maxLen || 0));
    if (text.length <= limit) return text.length;

    const minLen = Math.max(1, Math.floor(limit * Math.max(0, Math.min(1, Number(minRatio || 0)))));
    const probes = ["\n\n", "\n", " "];
    for (const probe of probes) {
      const idx = text.lastIndexOf(probe, limit);
      if (idx >= minLen) {
        return probe === " " ? idx : idx + probe.length;
      }
    }
    return limit;
  }

  function trailingTwoLineBlockStart(text) {
    const value = String(text || "");
    const trimmed = value.trimEnd();
    if (!trimmed) return -1;
    const lastNl = trimmed.lastIndexOf("\n");
    if (lastNl < 0) return -1;
    const secondLastNl = trimmed.lastIndexOf("\n", lastNl - 1);
    return secondLastNl >= 0 ? secondLastNl + 1 : 0;
  }

  function splitTextByLimit(text, limit) {
    const value = String(text || "");
    if (!value) return [];
    const chunks = [];
    let rest = value;
    while (rest.length > limit) {
      let cut = preferredSplitIndex(rest, limit, 0.7);
      if (!Number.isInteger(cut) || cut <= 0 || cut > rest.length) {
        cut = limit;
      }
      const chunk = rest.slice(0, cut).trimEnd();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      rest = rest.slice(cut).trimStart();
    }
    if (rest.trim().length > 0) {
      chunks.push(rest.trimEnd());
    }
    return chunks;
  }

  function splitCaptionAndOverflow(text) {
    const value = String(text || "");
    if (value.length <= MAX_MEDIA_CAPTION_LENGTH) {
      return { caption: value, overflow: "", trimmed: false };
    }
    let cut = preferredSplitIndex(value, MAX_MEDIA_CAPTION_LENGTH, 0.75);
    const footerStart = trailingTwoLineBlockStart(value);
    if (
      footerStart > 0 &&
      footerStart < cut &&
      cut > footerStart &&
      value.length - footerStart <= 400
    ) {
      // Keep a short trailing two-line footer block together (for auto-append footers).
      cut = footerStart;
    }
    if (!Number.isInteger(cut) || cut <= 0 || cut >= value.length) {
      cut = MAX_MEDIA_CAPTION_LENGTH;
    }
    return {
      caption: value.slice(0, cut).trimEnd(),
      overflow: value.slice(cut).trimStart(),
      trimmed: true
    };
  }

  async function sendLongTextAsChunks(client, destination, text, description, formattingEntities) {
    const value = String(text || "");
    if (!value.trim()) {
      return null;
    }

    if (value.length <= MAX_TEXT_MESSAGE_LENGTH) {
      if (DRY_RUN) {
        console.log(`[dry-run] ${description}: ${value.slice(0, 80)}`);
        return { id: 1 };
      }
      return withFloodWaitRetry(
        () =>
          client.sendMessage(destination, {
            message: value,
            formattingEntities: formattingEntities || undefined,
            parseMode: false
          }),
        description
      );
    }

    const chunks = splitTextByLimit(value, MAX_TEXT_MESSAGE_LENGTH);
    let firstSent = null;
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const chunkDescription = `${description} (part ${i + 1}/${chunks.length})`;
      if (DRY_RUN) {
        console.log(`[dry-run] ${chunkDescription}: ${chunk.slice(0, 80)}`);
        if (!firstSent) firstSent = { id: 1 };
        continue;
      }
      const sent = await withFloodWaitRetry(
        () =>
          client.sendMessage(destination, {
            message: chunk,
            parseMode: false
          }),
        chunkDescription
      );
      if (!firstSent) {
        firstSent = sent || null;
      }
    }

    return firstSent;
  }

  async function sendTextMessage(client, destination, message, text, formattingEntities) {
    const sent = await sendLongTextAsChunks(
      client,
      destination,
      text,
      `send text #${message.id}`,
      formattingEntities
    );
    return sent || null;
  }

  async function forwardMessage(client, source, destination, message) {
    if (DRY_RUN) {
      console.log(`[dry-run] forward #${message.id}`);
      return true;
    }
    await withFloodWaitRetry(
      () =>
        client.forwardMessages(destination, {
          messages: [message.id],
          fromPeer: source
        }),
      `forward #${message.id}`
    );
    return true;
  }

  async function forwardMessageGroup(client, source, destination, messages) {
    if (DRY_RUN) {
      const ids = messages.map((m) => m.id).join(",");
      console.log(`[dry-run] forward grouped [${ids}]`);
      return true;
    }
    await withFloodWaitRetry(
      () =>
        client.forwardMessages(destination, {
          messages: messages.map((m) => m.id),
          fromPeer: source
        }),
      `forward grouped #${messages[0].id}-#${messages[messages.length - 1].id}`
    );
    return true;
  }

  async function reuploadMessageMedia(
    client,
    destination,
    message,
    downloadedMedia,
    captionText,
    formattingEntities,
    options = {}
  ) {
    if (!message.media) {
      return null;
    }
    if (DRY_RUN) {
      console.log(`[dry-run] reupload media #${message.id}`);
      return { id: message.id };
    }

    const media = downloadedMedia ?? (await downloadMessageMedia(client, message));
    if (!media) {
      console.warn(`Skipping #${message.id}: unable to download media.`);
      return false;
    }

    const prepared = prepareUploadFileInput(message, media);
    const fileToSend = prepared.file;
    const forceDocument = shouldForceDocumentForReupload(message);
    const captionParts = splitCaptionAndOverflow(captionText || "");
    const canUseEntities = !captionParts.trimmed;
    const suppressOverflowText = !!options.suppressOverflowText;

    try {
      const sent = await withFloodWaitRetry(
        () =>
          client.sendFile(destination, {
            file: fileToSend,
            caption: captionParts.caption,
            formattingEntities: canUseEntities ? formattingEntities || undefined : undefined,
            parseMode: false,
            forceDocument: forceDocument
          }),
        `upload media #${message.id}`
      );
      if (!suppressOverflowText && captionParts.overflow.trim()) {
        await sendLongTextAsChunks(
          client,
          destination,
          captionParts.overflow,
          `send overflow text for media #${message.id}`,
          undefined
        );
      }
      return sent || null;
    } finally {
      if (prepared.cleanupPath) {
        fs.rmSync(prepared.cleanupPath, { force: true });
      }
    }
  }

  async function reuploadGroupedMedia(
    client,
    destination,
    messages,
    downloadedMediaById,
    captions,
    options = {}
  ) {
    if (DRY_RUN) {
      const ids = messages.map((m) => m.id).join(",");
      console.log(`[dry-run] reupload grouped [${ids}]`);
      return messages.map((m) => ({ id: m.id }));
    }

    const files = [];
    const cleanupPaths = [];
    const captionParts = captions.map((c) => splitCaptionAndOverflow(c || ""));
    const suppressOverflowByIndex = options.suppressOverflowByIndex instanceof Set
      ? options.suppressOverflowByIndex
      : new Set();

    for (const message of messages) {
      const media = downloadedMediaById.get(message.id) ?? (await downloadMessageMedia(client, message));
      if (!media) {
        console.warn(`Skipping grouped post: unable to download media for #${message.id}`);
        return false;
      }
      const prepared = prepareUploadFileInput(message, media);
      files.push(prepared.file);
      if (prepared.cleanupPath) {
        cleanupPaths.push(prepared.cleanupPath);
      }
    }

    try {
      const sent = await withFloodWaitRetry(
        () =>
          client.sendFile(destination, {
            file: files,
            caption: captionParts.map((x) => x.caption),
            parseMode: false,
            forceDocument: false
          }),
        `upload grouped #${messages[0].id}-#${messages[messages.length - 1].id}`
      );

      for (let i = 0; i < captionParts.length; i += 1) {
        const overflow = captionParts[i].overflow;
        if (!overflow.trim()) continue;
        if (suppressOverflowByIndex.has(i)) continue;
        await sendLongTextAsChunks(
          client,
          destination,
          overflow,
          `send overflow text for grouped media #${messages[i].id}`,
          undefined
        );
      }

      if (Array.isArray(sent)) {
        return sent;
      }
      return sent ? [sent] : [];
    } finally {
      for (const filePath of cleanupPaths) {
        fs.rmSync(filePath, { force: true });
      }
    }
  }

  return {
    forwardMessage,
    forwardMessageGroup,
    reuploadGroupedMedia,
    reuploadMessageMedia,
    sendTextMessage
  };
}

module.exports = {
  createPostSendHelpers
};
