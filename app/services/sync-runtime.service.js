const { loadRuntimeConfig } = require("./sync/runtime-config");
const { createRuntimeServiceFactory } = require("./sync/runtime-service.factory");

let runtimeServiceFactory = null;

function getRuntimeServiceFactory() {
  if (runtimeServiceFactory) {
    return runtimeServiceFactory;
  }
  const runtimeConfig = loadRuntimeConfig();
  runtimeServiceFactory = createRuntimeServiceFactory(runtimeConfig);
  return runtimeServiceFactory;
}

function applyCommandContext(commandContext) {
  if (!commandContext || !commandContext.command) {
    throw new Error("Missing command context.");
  }
  const isSrc2Local = !!commandContext.isSrc2Local;
  const isLocal2Dest = !!commandContext.isLocal2Dest;
  const infoTag = String(commandContext.infoTag || (isSrc2Local ? "[DL-INFO]" : "[UL-INFO]"));
  return {
    command: String(commandContext.command || "").toLowerCase(),
    infoTag,
    isLocal2Dest,
    isSrc2Local,
    local2Profile: commandContext.local2Profile || null
  };
}

function start(commandContext) {
  const commandState = applyCommandContext(commandContext);
  return getRuntimeServiceFactory().start(commandState);
}

module.exports = {
  start
};
