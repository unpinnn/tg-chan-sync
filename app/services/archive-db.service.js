"use strict";

const { DatabaseSync } = require("node:sqlite");
const {
  normalizeCloneMessageRow
} = require("../models/clone-message-record.model");
const {
  buildPostedPostMappingPairs
} = require("../models/post-record.model");
const {
  normalizeMediaFileRow,
  toPositiveInt
} = require("../models/media-file-record.model");

function createArchiveDbService(options = {}) {
  const fs = options.fs;
  const ARCHIVE_DIR = options.archiveDir;
  const ARCHIVE_DB_PATH = options.archiveDbPath;
  const storedPathToAbsolute = options.storedPathToAbsolute;

  function ensureArchiveRoot() {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  function sqlRun(db, sql, params = []) {
    const stmt = db.prepare(sql);
    return stmt.run(...params);
  }

  function sqlAll(db, sql, params = []) {
    const stmt = db.prepare(sql);
    return stmt.all(...params);
  }

  function sqlOne(db, sql, params = []) {
    const stmt = db.prepare(sql);
    const row = stmt.get(...params);
    return row || null;
  }

  function getMetaValue(db, key) {
    const row = sqlOne(db, "SELECT value FROM meta WHERE key = ?", [String(key || "")]);
    return row ? String(row.value ?? "") : "";
  }

  function setMetaValue(db, key, value) {
    const k = String(key || "");
    const v = String(value ?? "");
    sqlRun(
      db,
      `INSERT INTO meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [k, v]
    );
  }

  function initArchiveDbSchema(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS clone_messages (
        pair_key TEXT NOT NULL,
        source_message_id INTEGER NOT NULL,
        post_primary_source_id INTEGER NOT NULL,
        destination_message_id INTEGER,
        status TEXT NOT NULL DEFAULT 'archived',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (pair_key, source_message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_clone_messages_pair_status
        ON clone_messages(pair_key, status);

      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair_key TEXT NOT NULL,
        primary_source_message_id INTEGER NOT NULL,
        folder_name TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        post_txt_path TEXT NOT NULL,
        title TEXT,
        message_ids TEXT,
        message_count INTEGER,
        media_count INTEGER,
        media_total_size_bytes INTEGER,
        grouped_id TEXT,
        original_date TEXT,
        original_date_end TEXT,
        edited_date TEXT,
        source_channel_input TEXT,
        has_media INTEGER,
        views INTEGER,
        forwards INTEGER,
        captions TEXT,
        destination_message_ids TEXT,
        destination_permalink TEXT,
        destination_permalinks TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(pair_key, primary_source_message_id)
      );

      CREATE TABLE IF NOT EXISTS media_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        source_message_id INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        size_bytes INTEGER,
        FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
        UNIQUE(post_id, relative_path)
      );

      CREATE TABLE IF NOT EXISTS destinations (
        pair_key TEXT PRIMARY KEY,
        source_id TEXT,
        destination_id TEXT,
        destination_title TEXT,
        destination_username TEXT,
        destination_icon_data_uri TEXT,
        destination_icon_relpath TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS post_destinations (
        pair_key TEXT NOT NULL,
        primary_source_message_id INTEGER NOT NULL,
        destination_message_ids TEXT,
        destination_permalink TEXT,
        destination_permalinks TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (pair_key, primary_source_message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_post_destinations_pair
        ON post_destinations(pair_key);
    `);
  }

  function runArchiveDbMigrations(db) {
    let changed = false;
    const statements = [
      "ALTER TABLE posts ADD COLUMN media_total_size_bytes INTEGER",
      "ALTER TABLE media_files ADD COLUMN size_bytes INTEGER",
      "ALTER TABLE posts ADD COLUMN destination_permalink TEXT",
      "ALTER TABLE posts ADD COLUMN destination_permalinks TEXT"
    ];
    for (const sql of statements) {
      try {
        db.exec(sql);
        changed = true;
      } catch (error) {
        const msg = String(error?.message || error || "").toLowerCase();
        const ignorable = msg.includes("duplicate column name") || msg.includes("already exists");
        if (!ignorable) {
          throw error;
        }
      }
    }
    return changed;
  }

  function backfillArchiveSizeColumns(db) {
    let changed = false;
    const mediaRows = sqlAll(
      db,
      "SELECT id, relative_path, size_bytes FROM media_files WHERE size_bytes IS NULL OR size_bytes <= 0"
    );
    for (const row of mediaRows) {
      const media = normalizeMediaFileRow(row);
      const mediaFile = storedPathToAbsolute(media.relativePath);
      const sizeBytes = mediaFile && fs.existsSync(mediaFile) ? fs.statSync(mediaFile).size : 0;
      const result = sqlRun(db, "UPDATE media_files SET size_bytes = ? WHERE id = ?", [
        sizeBytes,
        media.id
      ]);
      if (result?.changes > 0) {
        changed = true;
      }
    }

    const postRows = sqlAll(
      db,
      `SELECT p.id AS post_id, COALESCE(SUM(COALESCE(m.size_bytes, 0)), 0) AS total_size
       FROM posts p
       LEFT JOIN media_files m ON m.post_id = p.id
       GROUP BY p.id`
    );
    for (const row of postRows) {
      const totalSize = Math.max(0, Number(row.total_size || 0));
      const postId = toPositiveInt(row.post_id);
      const result = sqlRun(
        db,
        "UPDATE posts SET media_total_size_bytes = ? WHERE id = ? AND COALESCE(media_total_size_bytes, -1) != ?",
        [totalSize, postId, totalSize]
      );
      if (result?.changes > 0) {
        changed = true;
      }
    }
    return changed;
  }

  function backfillLegacyPostDestinationColumns(db) {
    let changed = false;
    const rows = sqlAll(
      db,
      `SELECT
         pair_key,
         primary_source_message_id,
         destination_message_ids,
         destination_permalink,
         destination_permalinks,
         updated_at
       FROM posts
       WHERE
         COALESCE(TRIM(destination_message_ids), '') != '' OR
         COALESCE(TRIM(destination_permalink), '') != '' OR
         COALESCE(TRIM(destination_permalinks), '') != ''`
    );
    const nowIso = new Date().toISOString();
    for (const row of rows) {
      const pairKey = String(row.pair_key || "").trim();
      const primarySourceMessageId = toPositiveInt(row.primary_source_message_id);
      if (!pairKey || !primarySourceMessageId) continue;
      const destinationMessageIds = String(row.destination_message_ids || "").trim();
      const destinationPermalink = String(row.destination_permalink || "").trim();
      const destinationPermalinks = String(row.destination_permalinks || "").trim();
      const updatedAt = String(row.updated_at || "").trim() || nowIso;
      const existing = sqlOne(
        db,
        `SELECT 1 AS ok
         FROM post_destinations
         WHERE pair_key = ? AND primary_source_message_id = ?
         LIMIT 1`,
        [pairKey, primarySourceMessageId]
      );
      if (existing) continue;
      const result = sqlRun(
        db,
        `INSERT INTO post_destinations (
           pair_key,
           primary_source_message_id,
           destination_message_ids,
           destination_permalink,
           destination_permalinks,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          pairKey,
          primarySourceMessageId,
          destinationMessageIds,
          destinationPermalink,
          destinationPermalinks,
          updatedAt
        ]
      );
      if (result?.changes > 0) {
        changed = true;
      }
    }
    return changed;
  }

  async function openArchiveDb() {
    ensureArchiveRoot();
    const db = new DatabaseSync(ARCHIVE_DB_PATH);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 10000");
    initArchiveDbSchema(db);
    const schemaChanged = runArchiveDbMigrations(db);
    const backfilled = backfillArchiveSizeColumns(db);
    const migratedPostDestinations = backfillLegacyPostDestinationColumns(db);
    if (schemaChanged || backfilled || migratedPostDestinations) {
      persistArchiveDb(db);
    }
    return db;
  }

  function persistArchiveDb(db) {
    if (!db) return;
    // Native SQLite persists statements immediately; this checkpoint keeps readers consistent.
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore when not in WAL mode
    }
  }

  function buildPairKey(source, destination) {
    return `${String(source?.id ?? "")}->${String(destination?.id ?? "")}`;
  }

  function parsePairKeyIds(pairKey) {
    const raw = String(pairKey || "");
    const idx = raw.indexOf("->");
    if (idx < 0) {
      return { sourceId: "", destinationId: "" };
    }
    return {
      sourceId: raw.slice(0, idx).trim(),
      destinationId: raw.slice(idx + 2).trim()
    };
  }

  function upsertDestinationRecord(db, input = {}) {
    const pairKey = String(input.pairKey || "").trim();
    if (!pairKey) return;
    const parsed = parsePairKeyIds(pairKey);
    const sourceId = String(input.sourceId || parsed.sourceId || "").trim();
    const destinationId = String(input.destinationId || parsed.destinationId || "").trim();
    const destinationTitle = String(input.destinationTitle || "").trim();
    const destinationUsername = String(input.destinationUsername || "").trim();
    const destinationIconDataUri = String(input.destinationIconDataUri || "").trim();
    const destinationIconRelpath = String(input.destinationIconRelpath || "").trim();
    const updatedAt = String(input.updatedAt || new Date().toISOString()).trim();

    sqlRun(
      db,
      `INSERT INTO destinations (
         pair_key, source_id, destination_id, destination_title, destination_username,
         destination_icon_data_uri, destination_icon_relpath, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pair_key) DO UPDATE SET
         source_id = excluded.source_id,
         destination_id = excluded.destination_id,
         destination_title = excluded.destination_title,
         destination_username = excluded.destination_username,
         destination_icon_data_uri = excluded.destination_icon_data_uri,
         destination_icon_relpath = excluded.destination_icon_relpath,
         updated_at = excluded.updated_at`,
      [
        pairKey,
        sourceId,
        destinationId,
        destinationTitle,
        destinationUsername,
        destinationIconDataUri,
        destinationIconRelpath,
        updatedAt
      ]
    );
  }

  function getDestinationRecordByPairKey(db, pairKey) {
    const key = String(pairKey || "").trim();
    if (!key) return null;
    const row = sqlOne(
      db,
      `SELECT
         pair_key,
         source_id,
         destination_id,
         destination_title,
         destination_username,
         destination_icon_data_uri,
         destination_icon_relpath,
         updated_at
       FROM destinations
       WHERE pair_key = ?
       LIMIT 1`,
      [key]
    );
    if (!row) return null;
    return {
      pairKey: String(row.pair_key || "").trim(),
      sourceId: String(row.source_id || "").trim(),
      destinationId: String(row.destination_id || "").trim(),
      destinationTitle: String(row.destination_title || "").trim(),
      destinationUsername: String(row.destination_username || "").trim(),
      destinationIconDataUri: String(row.destination_icon_data_uri || "").trim(),
      destinationIconRelpath: String(row.destination_icon_relpath || "").trim(),
      updatedAt: String(row.updated_at || "").trim()
    };
  }

  function getLatestDestinationRecordForSource(db, sourceId) {
    const src = String(sourceId || "").trim();
    if (!src) return null;
    const row = sqlOne(
      db,
      `SELECT
         pair_key,
         source_id,
         destination_id,
         destination_title,
         destination_username,
         destination_icon_data_uri,
         destination_icon_relpath,
         updated_at
       FROM destinations
       WHERE source_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [src]
    );
    if (!row) return null;
    return {
      pairKey: String(row.pair_key || "").trim(),
      sourceId: String(row.source_id || "").trim(),
      destinationId: String(row.destination_id || "").trim(),
      destinationTitle: String(row.destination_title || "").trim(),
      destinationUsername: String(row.destination_username || "").trim(),
      destinationIconDataUri: String(row.destination_icon_data_uri || "").trim(),
      destinationIconRelpath: String(row.destination_icon_relpath || "").trim(),
      updatedAt: String(row.updated_at || "").trim()
    };
  }

  function loadPairStateFromDb(db, pairKey) {
    const processedRows = sqlAll(
      db,
      `SELECT source_message_id
       FROM clone_messages
       WHERE pair_key = ?
         AND (status = 'posted' OR destination_message_id IS NOT NULL)`,
      [pairKey]
    );
    const processedSourceIds = new Set(
      processedRows
        .map((r) => normalizeCloneMessageRow(r).sourceMessageId)
        .filter((x) => Number.isInteger(x) && x > 0)
    );

    const mappingRows = sqlAll(
      db,
      "SELECT source_message_id, destination_message_id FROM clone_messages WHERE pair_key = ? AND destination_message_id IS NOT NULL",
      [pairKey]
    );
    const sourceToDestination = new Map();
    for (const row of mappingRows) {
      const normalized = normalizeCloneMessageRow(row);
      const src = normalized.sourceMessageId;
      const dst = normalized.destinationMessageId;
      if (Number.isInteger(src) && src > 0 && Number.isInteger(dst) && dst > 0) {
        sourceToDestination.set(src, dst);
      }
    }

    const postedPosts = sqlAll(
      db,
      `SELECT p.message_ids, pd.destination_message_ids
       FROM posts p
       JOIN post_destinations pd
         ON pd.pair_key = p.pair_key
        AND pd.primary_source_message_id = p.primary_source_message_id
       WHERE p.pair_key = ?
         AND COALESCE(TRIM(pd.destination_message_ids), '') != ''`,
      [pairKey]
    );
    for (const row of postedPosts) {
      const pairs = buildPostedPostMappingPairs(row);
      for (const pair of pairs) {
        processedSourceIds.add(pair.sourceMessageId);
        if (!sourceToDestination.has(pair.sourceMessageId)) {
          sourceToDestination.set(pair.sourceMessageId, pair.destinationMessageId);
        }
      }
    }

    return { processedSourceIds, sourceToDestination };
  }

  function resetPairPostingState(db, pairKey) {
    const nowIso = new Date().toISOString();
    sqlRun(
      db,
      `UPDATE clone_messages
       SET destination_message_id = NULL,
           status = 'archived',
           updated_at = ?
       WHERE pair_key = ?`,
      [nowIso, String(pairKey || "")]
    );
    sqlRun(
      db,
      `DELETE FROM post_destinations
       WHERE pair_key = ?`,
      [String(pairKey || "")]
    );
    sqlRun(
      db,
      `UPDATE posts
       SET destination_message_ids = '',
           destination_permalink = '',
           destination_permalinks = '',
           updated_at = ?
       WHERE pair_key = ?`,
      [nowIso, String(pairKey || "")]
    );
  }

  return {
    buildPairKey,
    getDestinationRecordByPairKey,
    getLatestDestinationRecordForSource,
    getMetaValue,
    loadPairStateFromDb,
    openArchiveDb,
    persistArchiveDb,
    resetPairPostingState,
    setMetaValue,
    sqlAll,
    sqlOne,
    sqlRun,
    upsertDestinationRecord
  };
}

module.exports = {
  createArchiveDbService
};
