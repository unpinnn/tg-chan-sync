const fs = require("fs");
const path = require("path");

function createArchivePathHelpers(deps = {}) {
  const formatTimestampForPath = deps.formatTimestampForPath;
  const sanitizePathPart = deps.sanitizePathPart;

  if (typeof formatTimestampForPath !== "function") {
    throw new Error("createArchivePathHelpers: formatTimestampForPath is required");
  }
  if (typeof sanitizePathPart !== "function") {
    throw new Error("createArchivePathHelpers: sanitizePathPart is required");
  }

  function toPosixRelativePath(absolutePath) {
    const rel = path.relative(process.cwd(), absolutePath);
    return rel.split(path.sep).join("/");
  }

  function buildArchiveFolderName(messages) {
    const first = messages[0];
    const ts = formatTimestampForPath(first?.date || new Date());
    const id = Number(first?.id || 0);
    return `${sanitizePathPart(ts)}__msg-${id}`;
  }

  function storedPathToAbsolute(storedPath) {
    const raw = String(storedPath || "").trim();
    if (!raw) return "";
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(raw.split("/").join(path.sep));
  }

  function fileSizeBytesSafe(filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return 0;
      }
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  return {
    buildArchiveFolderName,
    fileSizeBytesSafe,
    storedPathToAbsolute,
    toPosixRelativePath
  };
}

module.exports = {
  createArchivePathHelpers
};
