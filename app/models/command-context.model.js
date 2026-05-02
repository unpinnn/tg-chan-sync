"use strict";

function normalizeCommand(rawCommand) {
  return String(rawCommand || "").trim().toLowerCase();
}

function createSrc2LocalContext(command, options = {}) {
  return {
    command,
    isSrc2Local: true,
    isLocal2Dest: false,
    infoTag: "[DL-INFO]",
    local2Profile: null,
    localArchiveDir: String(options.localArchiveDir || "").trim(),
    envFilePath: String(options.envFilePath || "").trim(),
    destChannelOverride: String(options.destChannelOverride || "").trim(),
    destChannelsOverride: String(options.destChannelsOverride || "").trim()
  };
}

function createLocal2Context(command, local2Profile, options = {}) {
  return {
    command,
    isSrc2Local: false,
    isLocal2Dest: command === "local2dest",
    infoTag: "[UL-INFO]",
    local2Profile: local2Profile || null,
    localArchiveDir: String(options.localArchiveDir || "").trim(),
    envFilePath: String(options.envFilePath || "").trim(),
    destChannelOverride: String(options.destChannelOverride || "").trim(),
    destChannelsOverride: String(options.destChannelsOverride || "").trim()
  };
}

module.exports = {
  createLocal2Context,
  createSrc2LocalContext,
  normalizeCommand
};
