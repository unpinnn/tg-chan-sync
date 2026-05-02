const { createArchivePathHelpers } = require("./archive-paths.helpers");
const { createArchiveWriteHelpers } = require("./archive-write.helpers");
const { createArchiveDbHelpers } = require("./archive-db.helpers");

function createArchiveHelpers(deps = {}) {
  const pathHelpers = createArchivePathHelpers({
    formatTimestampForPath: deps.formatTimestampForPath,
    sanitizePathPart: deps.sanitizePathPart
  });

  const writeHelpers = createArchiveWriteHelpers({
    ARCHIVE_DIR: deps.ARCHIVE_DIR,
    SOURCE_CHANNEL: deps.SOURCE_CHANNEL,
    HEARTBEAT_LOG_MS: deps.HEARTBEAT_LOG_MS,
    toIsoStringSafe: deps.toIsoStringSafe,
    withHeartbeatLog: deps.withHeartbeatLog,
    downloadMessageMedia: deps.downloadMessageMedia,
    buildArchiveMediaName: deps.buildArchiveMediaName,
    buildPostTitleFromMessages: deps.buildPostTitleFromMessages,
    buildArchiveFolderName: pathHelpers.buildArchiveFolderName,
    toPosixRelativePath: pathHelpers.toPosixRelativePath
  });

  const dbHelpers = createArchiveDbHelpers({
    SOURCE_CHANNEL: deps.SOURCE_CHANNEL,
    toIsoStringSafe: deps.toIsoStringSafe,
    buildPostTitleFromMessages: deps.buildPostTitleFromMessages,
    getMessageMediaSizeInfo: deps.getMessageMediaSizeInfo,
    toPosixRelativePath: pathHelpers.toPosixRelativePath,
    storedPathToAbsolute: pathHelpers.storedPathToAbsolute,
    fileSizeBytesSafe: pathHelpers.fileSizeBytesSafe,
    sqlRun: deps.sqlRun,
    sqlOne: deps.sqlOne,
    sqlAll: deps.sqlAll
  });

  return {
    ...pathHelpers,
    ...writeHelpers,
    ...dbHelpers
  };
}

module.exports = {
  createArchiveHelpers
};
