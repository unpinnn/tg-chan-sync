"use strict";

const fs = require("fs");
const path = require("path");

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function createStateStore(statePath) {
  const state = readJsonSafe(statePath, {
    completed_ids: [],
    failed: []
  });
  if (!Array.isArray(state.completed_ids)) state.completed_ids = [];
  if (!Array.isArray(state.failed)) state.failed = [];
  const completed = new Set(
    state.completed_ids
      .map((x) => Number.parseInt(String(x || 0), 10))
      .filter((x) => Number.isInteger(x) && x > 0)
  );
  const failed = new Map();
  for (const item of state.failed) {
    const id = Number.parseInt(String(item?.id || 0), 10);
    if (!Number.isInteger(id) || id <= 0) continue;
    failed.set(id, {
      id,
      reason: String(item?.reason || ""),
      at: String(item?.at || new Date().toISOString())
    });
  }

  const save = () => {
    writeJsonSafe(statePath, {
      completed_ids: Array.from(completed.values()).sort((a, b) => a - b),
      failed: Array.from(failed.values()).sort((a, b) => a.id - b.id)
    });
  };

  return {
    isDone(id) {
      return completed.has(Number(id));
    },
    markComplete(id) {
      const safeId = Number.parseInt(String(id || 0), 10);
      if (!Number.isInteger(safeId) || safeId <= 0) return;
      completed.add(safeId);
      failed.delete(safeId);
      save();
    },
    markFailed(id, reason) {
      const safeId = Number.parseInt(String(id || 0), 10);
      if (!Number.isInteger(safeId) || safeId <= 0) return;
      failed.set(safeId, {
        id: safeId,
        reason: String(reason || "").slice(0, 1000),
        at: new Date().toISOString()
      });
      completed.add(safeId);
      save();
    },
    snapshot() {
      return {
        completedCount: completed.size,
        failedCount: failed.size
      };
    }
  };
}

module.exports = {
  createStateStore
};

