"use strict";

function createActiveScopeRef(startDate, startMs, endDate, endMs) {
  return {
    startDate: startDate || null,
    startMs: Number(startMs || 0),
    endDate: endDate || null,
    endMs: Number(endMs || 0)
  };
}

function resetActiveScopeRef(activeScopeRef, startDate, startMs, endDate, endMs) {
  if (!activeScopeRef) {
    return createActiveScopeRef(startDate, startMs, endDate, endMs);
  }
  activeScopeRef.startDate = startDate || null;
  activeScopeRef.startMs = Number(startMs || 0);
  activeScopeRef.endDate = endDate || null;
  activeScopeRef.endMs = Number(endMs || 0);
  return activeScopeRef;
}

module.exports = {
  createActiveScopeRef,
  resetActiveScopeRef
};
