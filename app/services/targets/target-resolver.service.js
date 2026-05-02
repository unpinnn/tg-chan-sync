"use strict";

function resolveTargetAdapter(input = {}) {
  const targetKey = String(input.targetKey || "dest").toLowerCase();
  const adaptersByKey = input.adaptersByKey || {};
  const adapterFactory = adaptersByKey[targetKey];
  if (typeof adapterFactory !== "function") {
    const supported = Object.keys(adaptersByKey).sort().join(", ");
    throw new Error(`No target adapter for key "${targetKey}". Supported: ${supported}`);
  }
  return adapterFactory();
}

module.exports = {
  resolveTargetAdapter
};
