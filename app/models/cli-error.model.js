"use strict";

class CliError extends Error {
  constructor(message, options = {}) {
    super(String(message || "CLI error"));
    this.name = "CliError";
    this.exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 1;
    this.userMessage = String(options.userMessage || this.message);
  }
}

function isCliError(error) {
  return !!error && error.name === "CliError" && Number.isInteger(error.exitCode);
}

module.exports = {
  CliError,
  isCliError
};
