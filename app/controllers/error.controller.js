"use strict";

const { isCliError } = require("../models/cli-error.model");

function handleFatalError(error) {
  if (isCliError(error)) {
    console.error(error.userMessage);
    return error.exitCode;
  }

  const message = String(error?.message || error || "Unknown error");
  console.error(`Fatal error: ${message}`);
  return 1;
}

module.exports = {
  handleFatalError
};
