"use strict";

function buildSeparatorLine() {
  return "======";
}

function buildTaggedLine(tag, message) {
  return `${String(tag || "[INFO]")} ${String(message || "")}`.trimEnd();
}

function buildSummaryLine(key, value) {
  const keyText = String(key || "");
  if (value == null || String(value) === "") {
    return buildTaggedLine("[SUMMARY]", keyText);
  }
  return buildTaggedLine("[SUMMARY]", `${keyText}: ${String(value)}`);
}

module.exports = {
  buildSeparatorLine,
  buildSummaryLine,
  buildTaggedLine
};
