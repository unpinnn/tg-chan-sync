"use strict";

const { start: startRuntime } = require("./sync-runtime.service");

function start(commandContext) {
  return startRuntime(commandContext);
}

module.exports = {
  start
};

