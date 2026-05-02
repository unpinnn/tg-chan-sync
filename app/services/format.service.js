"use strict";

const fs = require("fs");

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeDate(value) {
  if (!value) return new Date(NaN);
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms);
  }
  return new Date(value);
}

function toIsoStringSafe(value) {
  if (!value) return "";
  const date = normalizeDate(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function toDateOnlyStringSafe(value) {
  const iso = toIsoStringSafe(value);
  return iso ? iso.slice(0, 10) : "";
}

function formatTimestampForPath(date) {
  const d = normalizeDate(date);
  const year = d.getFullYear();
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hour = pad2(d.getHours());
  const minute = pad2(d.getMinutes());
  const second = pad2(d.getSeconds());
  return `${year}-${month}-${day}_${hour}-${minute}-${second}`;
}

function sanitizePathPart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFileName(value) {
  const safe = sanitizePathPart(value).replace(/^\.+/, "");
  return safe || "file.bin";
}

function nextAvailablePath(basePath, existsFn = null) {
  const pathExists = typeof existsFn === "function" ? existsFn : fs.existsSync;
  if (!pathExists(basePath)) {
    return basePath;
  }
  let i = 2;
  for (;;) {
    const candidate = `${basePath}-${i}`;
    if (!pathExists(candidate)) {
      return candidate;
    }
    i += 1;
  }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const rounded = value >= 100 || unitIdx === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[unitIdx]}`;
}

function formatDurationShort(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${pad2(m)}:${pad2(sec)}`;
  }
  return `${m}:${pad2(sec)}`;
}

function formatDurationVerbose(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h} hour(s) ${m} min ${sec} sec`;
  }
  if (m > 0) {
    return `${m} min ${sec} sec`;
  }
  return `${sec} sec`;
}

function formatRunDuration(ms) {
  const totalMs = Math.max(0, Number(ms || 0));
  if (totalMs < 1000) {
    return "less than a second";
  }
  if (totalMs < 60000) {
    return `${(totalMs / 1000).toFixed(2)} sec`;
  }
  const totalMinutes = totalMs / 60000;
  if (totalMinutes < 60) {
    return `${totalMinutes.toFixed(2)} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);
  return `${hours} hour(s), ${minutes} min(s)`;
}

module.exports = {
  formatBytes,
  formatDurationShort,
  formatDurationVerbose,
  formatRunDuration,
  formatTimestampForPath,
  nextAvailablePath,
  normalizeDate,
  pad2,
  sanitizeFileName,
  sanitizePathPart,
  toDateOnlyStringSafe,
  toIsoStringSafe
};
