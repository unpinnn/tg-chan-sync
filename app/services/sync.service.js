"use strict";

const { start: startSrc2Local } = require("./src2local.service");
const { start: startLocal2Dest } = require("./local2dest.service");

function start(commandContext) {
  if (!commandContext || !commandContext.command) {
    throw new Error("Missing command context.");
  }
  if (commandContext.isSrc2Local) {
    return startSrc2Local(commandContext);
  }
  return startLocal2Dest(commandContext);
}

module.exports = {
  start
};

