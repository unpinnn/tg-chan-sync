"use strict";

const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

function mimeFromExt(filePath) {
  const ext = String(path.extname(String(filePath || "")).toLowerCase());
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg"
  };
  return map[ext] || "application/octet-stream";
}

function normalizeCaptionText(captions) {
  const text = String(captions || "").replace(/\r\n/g, "\n");
  if (!text.trim()) return "";
  return text
    .split(/\n\n(?=#\d+:)/)
    .map((block) => block.replace(/^#\d+:\s*/m, "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function parseJsonArraySafe(text) {
  try {
    const value = JSON.parse(String(text || "[]"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function createJobsStore(config) {
  if (!fs.existsSync(config.archiveDbPath)) {
    throw new Error(`Archive DB not found: ${config.archiveDbPath}`);
  }
  const SQL = await initSqlJs();
  const dbBytes = fs.readFileSync(config.archiveDbPath);
  const db = new SQL.Database(dbBytes);

  const sqlAll = (query, params = []) => {
    const stmt = db.prepare(query);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  };

  const resolvePairKey = () => {
    if (config.pairKey) return config.pairKey;
    const row = sqlAll(
      `SELECT pair_key, COUNT(*) AS c
       FROM posts
       GROUP BY pair_key
       ORDER BY c DESC
       LIMIT 1`
    )[0];
    return String(row?.pair_key || "").trim();
  };

  const pairKey = resolvePairKey();
  if (!pairKey) {
    throw new Error("No posts found in archive DB.");
  }

  const posts = sqlAll(
    `SELECT id, primary_source_message_id, title, captions, message_ids, media_count, original_date
     FROM posts
     WHERE pair_key = ?
     ORDER BY primary_source_message_id ASC`,
    [pairKey]
  );

  const jobs = [];
  for (const row of posts) {
    const sourceId = Number.parseInt(String(row.primary_source_message_id || 0), 10);
    if (!Number.isInteger(sourceId) || sourceId <= 0) continue;
    if (config.startFromId > 0 && sourceId < config.startFromId) continue;
    if (config.endAtId > 0 && sourceId > config.endAtId) continue;

    const mediaRows = sqlAll(
      `SELECT id, relative_path, size_bytes
       FROM media_files
       WHERE post_id = ?
       ORDER BY id ASC`,
      [row.id]
    );
    const media = [];
    for (const mediaRow of mediaRows) {
      const relativePath = String(mediaRow.relative_path || "").trim();
      if (!relativePath) continue;
      const absolutePath = path.resolve(relativePath.split("/").join(path.sep));
      if (!fs.existsSync(absolutePath)) continue;
      media.push({
        index: media.length,
        fileName: path.basename(absolutePath),
        absolutePath,
        mimeType: mimeFromExt(absolutePath),
        sizeBytes: Number.parseInt(String(mediaRow.size_bytes || 0), 10) || 0
      });
    }

    jobs.push({
      id: sourceId,
      postId: Number.parseInt(String(row.id || 0), 10),
      title: String(row.title || ""),
      text: normalizeCaptionText(row.captions),
      originalDate: String(row.original_date || ""),
      messageIds: parseJsonArraySafe(row.message_ids),
      media
    });
  }

  const claimedAt = new Map();
  const claimTtlMs = 5 * 60 * 1000;

  const clearExpiredClaims = () => {
    const now = Date.now();
    for (const [id, ts] of claimedAt.entries()) {
      if (now - ts > claimTtlMs) {
        claimedAt.delete(id);
      }
    }
  };

  return {
    pairKey,
    listJobs() {
      return jobs;
    },
    nextJob(isDone) {
      clearExpiredClaims();
      for (const job of jobs) {
        if (isDone(job.id)) continue;
        if (claimedAt.has(job.id)) continue;
        claimedAt.set(job.id, Date.now());
        return job;
      }
      return null;
    },
    releaseClaim(id) {
      claimedAt.delete(Number(id));
    },
    findJob(id) {
      const safeId = Number.parseInt(String(id || 0), 10);
      if (!Number.isInteger(safeId) || safeId <= 0) return null;
      return jobs.find((job) => job.id === safeId) || null;
    },
    close() {
      db.close();
    }
  };
}

module.exports = {
  createJobsStore
};

