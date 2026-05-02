"use strict";

const path = require("path");

function toBool(value, fallback = false) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  return ["1", "true", "yes", "on"].includes(text);
}

function toInt(value, fallback, min = 0) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function loadConfig(env = process.env, options = {}) {
  const rootDir = path.resolve(__dirname, "..", "..");
  const localArchiveDir = String(options.localArchiveDir || "").trim();
  const envArchiveDir = String(env.LOCAL_ARCHIVE_DIR || "channel-archive").trim();
  const webextArchiveDbOverride = String(env.WEBEXT_ARCHIVE_DB_PATH || "").trim();
  const archiveDbPath = localArchiveDir
    ? path.resolve(rootDir, localArchiveDir, "archive.db")
    : webextArchiveDbOverride
      ? path.resolve(rootDir, webextArchiveDbOverride)
      : path.resolve(rootDir, envArchiveDir, "archive.db");
  return {
    host: String(env.WEBEXT_SERVER_HOST || "127.0.0.1").trim(),
    port: toInt(env.WEBEXT_SERVER_PORT, 37891, 1),
    token: String(env.WEBEXT_SERVER_TOKEN || "").trim(),
    archiveDbPath,
    statePath: path.resolve(
      rootDir,
      String(env.WEBEXT_STATE_PATH || "webext/serv/state.json").trim()
    ),
    pairKey: String(env.WEBEXT_PAIR_KEY || "").trim(),
    startFromId: toInt(env.WEBEXT_START_FROM_ID || env.START_FROM_ID, 0, 0),
    endAtId: toInt(env.WEBEXT_END_AT_ID || env.END_AT_ID, 0, 0),
    dryRun: toBool(env.WEBEXT_DRY_RUN, false)
  };
}

module.exports = {
  loadConfig
};
