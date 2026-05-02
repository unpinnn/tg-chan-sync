"use strict";

function assertValidTargetAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Target adapter is missing.");
  }
  if (!String(adapter.key || "").trim()) {
    throw new Error("Target adapter must provide a non-empty key.");
  }
  if (typeof adapter.assertPostMode !== "function") {
    throw new Error(`Target adapter "${adapter.key}" must implement assertPostMode(postMode).`);
  }
  if (typeof adapter.postMessages !== "function") {
    throw new Error(`Target adapter "${adapter.key}" must implement postMessages(ctx).`);
  }
  if (
    Object.prototype.hasOwnProperty.call(adapter, "resetBeforePosting") &&
    typeof adapter.resetBeforePosting !== "function"
  ) {
    throw new Error(
      `Target adapter "${adapter.key}" resetBeforePosting must be a function when provided.`
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(adapter, "preflightBeforeRun") &&
    typeof adapter.preflightBeforeRun !== "function"
  ) {
    throw new Error(
      `Target adapter "${adapter.key}" preflightBeforeRun must be a function when provided.`
    );
  }
}

module.exports = {
  assertValidTargetAdapter
};
