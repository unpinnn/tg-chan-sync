const fs = require("fs");
const path = require("path");

function createArchiveWriteHelpers(deps = {}) {
  const ARCHIVE_DIR = deps.ARCHIVE_DIR;
  const SOURCE_CHANNEL = deps.SOURCE_CHANNEL;
  const HEARTBEAT_LOG_MS = deps.HEARTBEAT_LOG_MS;
  const toIsoStringSafe = deps.toIsoStringSafe;
  const withHeartbeatLog = deps.withHeartbeatLog;
  const downloadMessageMedia = deps.downloadMessageMedia;
  const buildArchiveMediaName = deps.buildArchiveMediaName;
  const buildPostTitleFromMessages = deps.buildPostTitleFromMessages;
  const buildArchiveFolderName = deps.buildArchiveFolderName;
  const toPosixRelativePath = deps.toPosixRelativePath;

  if (!ARCHIVE_DIR) throw new Error("createArchiveWriteHelpers: ARCHIVE_DIR is required");
  if (!SOURCE_CHANNEL) throw new Error("createArchiveWriteHelpers: SOURCE_CHANNEL is required");
  if (typeof toIsoStringSafe !== "function") {
    throw new Error("createArchiveWriteHelpers: toIsoStringSafe is required");
  }
  if (typeof withHeartbeatLog !== "function") {
    throw new Error("createArchiveWriteHelpers: withHeartbeatLog is required");
  }
  if (typeof downloadMessageMedia !== "function") {
    throw new Error("createArchiveWriteHelpers: downloadMessageMedia is required");
  }
  if (typeof buildArchiveMediaName !== "function") {
    throw new Error("createArchiveWriteHelpers: buildArchiveMediaName is required");
  }
  if (typeof buildPostTitleFromMessages !== "function") {
    throw new Error("createArchiveWriteHelpers: buildPostTitleFromMessages is required");
  }
  if (typeof buildArchiveFolderName !== "function") {
    throw new Error("createArchiveWriteHelpers: buildArchiveFolderName is required");
  }
  if (typeof toPosixRelativePath !== "function") {
    throw new Error("createArchiveWriteHelpers: toPosixRelativePath is required");
  }

  function writeArchivePostMetadata(postDir, messages, textByMessageId) {
    const first = messages[0];
    const last = messages[messages.length - 1];
    const title = buildPostTitleFromMessages(messages);
    const captions = messages
      .map((m) => ({
        id: m.id,
        text: textByMessageId?.get(m.id) ?? (m?.message || "")
      }))
      .filter((x) => String(x.text).trim())
      .map((x) => `#${x.id}: ${x.text}`);
    const dateIso = toIsoStringSafe(first?.date);
    const endDateIso = toIsoStringSafe(last?.date);
    const editIso = toIsoStringSafe(first?.editDate);
    const messageIds = messages.map((m) => m.id).join(",");
    const mediaCount = messages.filter((m) => !!m.media).length;
    const groupedId = first?.groupedId != null ? String(first.groupedId) : "";
    const metadata = [
      `title: ${title}`,
      `message_ids: ${messageIds}`,
      `message_count: ${messages.length}`,
      `media_count: ${mediaCount}`,
      `grouped_id: ${groupedId}`,
      `original_date: ${dateIso}`,
      `original_date_end: ${endDateIso}`,
      `edited_date: ${editIso}`,
      `source_channel_input: ${SOURCE_CHANNEL}`,
      `has_media: ${mediaCount > 0 ? "true" : "false"}`,
      `views: ${first?.views ?? ""}`,
      `forwards: ${first?.forwards ?? ""}`,
      "",
      "captions:"
    ].join("\n");
    fs.writeFileSync(path.join(postDir, "post.txt"), `${metadata}\n${captions.join("\n\n")}\n`, "utf8");
  }

  async function archivePostLocally(client, messages, downloadedMediaById, textByMessageId) {
    const baseFolder = path.join(ARCHIVE_DIR, buildArchiveFolderName(messages));
    const postDir = baseFolder;
    fs.mkdirSync(postDir, { recursive: true });

    writeArchivePostMetadata(postDir, messages, textByMessageId);

    const mediaRecords = [];

    for (const message of messages) {
      if (!message.media) {
        continue;
      }

      const media =
        downloadedMediaById.get(message.id) ??
        (await withHeartbeatLog(
          `download_stage: downloading #${message.id}`,
          () => downloadMessageMedia(client, message),
          HEARTBEAT_LOG_MS,
          { logElapsed: false }
        ));
      if (!media) {
        console.warn(`Archive: unable to download media for #${message.id}`);
        continue;
      }

      const mediaFile = path.join(postDir, buildArchiveMediaName(message));
      if (Buffer.isBuffer(media)) {
        if (!fs.existsSync(mediaFile)) {
          fs.writeFileSync(mediaFile, media);
        }
      } else if (typeof media === "string" && fs.existsSync(media)) {
        if (!fs.existsSync(mediaFile)) {
          fs.copyFileSync(media, mediaFile);
        }
      } else {
        console.warn(`Archive: unsupported media payload type for #${message.id}`);
      }

      mediaRecords.push({
        sourceMessageId: message.id,
        relativePath: toPosixRelativePath(mediaFile),
        sizeBytes: fs.existsSync(mediaFile) ? fs.statSync(mediaFile).size : 0
      });
    }

    return {
      postDir,
      postTxtPath: path.join(postDir, "post.txt"),
      mediaRecords
    };
  }

  return {
    archivePostLocally,
    writeArchivePostMetadata
  };
}

module.exports = {
  createArchiveWriteHelpers
};
