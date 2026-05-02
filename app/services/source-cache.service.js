const path = require("path");
const { createSyntheticScanUtils } = require("./source-cache/synthetic-scan.utils");

function createSourceCacheService(options = {}) {
  const fs = options.fs;
  const crypto = options.crypto;
  const normalizeDate = options.normalizeDate;
  const toIsoStringSafe = options.toIsoStringSafe;
  const usernameFromInput = options.usernameFromInput;
  const extensionForMessage = options.extensionForMessage;
  const fileSizeBytesSafe = options.fileSizeBytesSafe;
  const storedPathToAbsolute = options.storedPathToAbsolute;
  const sqlAll = options.sqlAll;
  const sourceChannelInput = String(options.sourceChannelInput || "");
  const destChannelInput = String(options.destChannelInput || "");
  const localArchiveDir = path.resolve(String(options.localArchiveDir || "channel-archive"));
  const fileCacheEnabled = !!options.fileCacheEnabled;
  const isSrc2Local = !!options.isSrc2Local;
  const fileCacheTtl = String(options.fileCacheTtl || "");
  const fileCachePath = path.resolve(String(options.fileCachePath || "./cache"));

  if (!fs) throw new Error("createSourceCacheService: fs is required");
  if (!crypto) throw new Error("createSourceCacheService: crypto is required");
  if (typeof normalizeDate !== "function") {
    throw new Error("createSourceCacheService: normalizeDate is required");
  }
  if (typeof toIsoStringSafe !== "function") {
    throw new Error("createSourceCacheService: toIsoStringSafe is required");
  }
  if (typeof usernameFromInput !== "function") {
    throw new Error("createSourceCacheService: usernameFromInput is required");
  }
  if (typeof extensionForMessage !== "function") {
    throw new Error("createSourceCacheService: extensionForMessage is required");
  }
  if (typeof fileSizeBytesSafe !== "function") {
    throw new Error("createSourceCacheService: fileSizeBytesSafe is required");
  }
  if (typeof storedPathToAbsolute !== "function") {
    throw new Error("createSourceCacheService: storedPathToAbsolute is required");
  }
  if (typeof sqlAll !== "function") {
    throw new Error("createSourceCacheService: sqlAll is required");
  }

  const syntheticUtils = createSyntheticScanUtils({
    normalizeDate,
    toIsoStringSafe,
    fileSizeBytesSafe,
    storedPathToAbsolute,
    sqlAll,
    sourceChannelInput
  });

  function parseFileCacheTtlMs(rawValue) {
    const raw = String(rawValue || "").trim().toLowerCase();
    const m = raw.match(/^(\d+)m$/);
    if (!m) {
      return 0;
    }
    const minutes = Number.parseInt(m[1], 10);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return 0;
    }
    return minutes * 60 * 1000;
  }

  function hashForCacheKey(text) {
    return crypto.createHash("sha1").update(String(text || "")).digest("hex").slice(0, 16);
  }

  function snapshotPeerForCache(peer) {
    if (!peer) return null;
    return {
      id: String(peer.id ?? ""),
      username: peer.username ? String(peer.username) : ""
    };
  }

  function peerFromCacheSnapshot(snapshot, fallbackInput) {
    const fallbackUsername = usernameFromInput(fallbackInput);
    const idText = String(snapshot?.id ?? "").trim();
    return {
      id: idText || `cache:${hashForCacheKey(String(fallbackInput || ""))}`,
      username: String(snapshot?.username || fallbackUsername || "")
    };
  }

  function buildFileCacheContext() {
    const ttlMs = parseFileCacheTtlMs(fileCacheTtl);
    const enabled = fileCacheEnabled && isSrc2Local && ttlMs > 0;
    const scopeKey = `${sourceChannelInput}=>local:${localArchiveDir}`;
    const scopeHash = hashForCacheKey(scopeKey);
    const rootDir = path.join(fileCachePath, scopeHash);
    return {
      enabled,
      ttlMs,
      scopeHash,
      rootDir,
      manifestPath: path.join(rootDir, "manifest.json"),
      scanPath: path.join(rootDir, "scan.json"),
      mediaDir: path.join(rootDir, "media")
    };
  }

  function ensureDirExists(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  function isFullScanManifest(manifest) {
    const startId = Number.parseInt(String(manifest?.start_from_id ?? 0), 10) || 0;
    const endId = Number.parseInt(String(manifest?.end_at_id ?? 0), 10) || 0;
    const startDate = String(manifest?.start_from_date || "").trim();
    const endDate = String(manifest?.end_at_date || "").trim();
    const scopeMark = String(manifest?.scan_scope || "").trim().toLowerCase();
    if (scopeMark === "full") {
      return true;
    }
    return startId === 0 && endId === 0 && !startDate && !endDate;
  }

  function loadScanCache(cacheContext) {
    if (!cacheContext?.enabled) return null;
    if (!fs.existsSync(cacheContext.manifestPath) || !fs.existsSync(cacheContext.scanPath)) {
      return null;
    }
    try {
      const manifestRaw = fs.readFileSync(cacheContext.manifestPath, "utf8");
      const manifest = JSON.parse(manifestRaw);
      if (!isFullScanManifest(manifest)) {
        return null;
      }
      const createdAtMs = Number(new Date(manifest?.created_at || 0).getTime());
      if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
        return null;
      }
      if (Date.now() - createdAtMs > cacheContext.ttlMs) {
        return null;
      }
      const scanRaw = fs.readFileSync(cacheContext.scanPath, "utf8");
      const scan = JSON.parse(scanRaw);
      if (!Array.isArray(scan?.post_units)) {
        return null;
      }
      return {
        manifest,
        scan
      };
    } catch {
      return null;
    }
  }

  function loadScanCacheUnchecked(cacheContext) {
    if (!cacheContext?.manifestPath || !cacheContext?.scanPath) {
      return null;
    }
    if (!fs.existsSync(cacheContext.manifestPath) || !fs.existsSync(cacheContext.scanPath)) {
      return null;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(cacheContext.manifestPath, "utf8"));
      const scan = JSON.parse(fs.readFileSync(cacheContext.scanPath, "utf8"));
      if (!Array.isArray(scan?.post_units)) {
        return null;
      }
      return { manifest, scan };
    } catch {
      return null;
    }
  }

  function normalizedSourceInputKey(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    const uname = usernameFromInput(raw);
    if (uname) return `@${uname}`;
    return raw.replace(/^@/, "");
  }

  function sourceInputsProbablyMatch(a, b) {
    const keyA = normalizedSourceInputKey(a);
    const keyB = normalizedSourceInputKey(b);
    if (!keyA || !keyB) return false;
    if (keyA === keyB) return true;
    return keyA.replace(/^@/, "") === keyB.replace(/^@/, "");
  }

  function findFallbackSourceCacheBundle(cacheBasePath, sourceInput) {
    const root = path.resolve(cacheBasePath || "./cache");
    if (!fs.existsSync(root)) {
      return null;
    }
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    let best = null;

    for (const entry of entries) {
      const scopeDir = path.join(root, entry.name);
      const manifestPath = path.join(scopeDir, "manifest.json");
      const scanPath = path.join(scopeDir, "scan.json");
      const bundle = loadScanCacheUnchecked({ manifestPath, scanPath });
      if (!bundle) {
        continue;
      }
      if (!isFullScanManifest(bundle.manifest)) {
        continue;
      }
      if (!sourceInputsProbablyMatch(bundle?.manifest?.source_channel_input, sourceInput)) {
        continue;
      }
      const units = Array.isArray(bundle?.scan?.post_units) ? bundle.scan.post_units.length : 0;
      const createdAt = Number(new Date(bundle?.manifest?.created_at || 0).getTime()) || 0;
      const candidate = {
        bundle,
        scopeDir,
        scanPath,
        units,
        createdAt
      };
      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.units > best.units) {
        best = candidate;
        continue;
      }
      if (candidate.units === best.units && candidate.createdAt > best.createdAt) {
        best = candidate;
      }
    }

    return best;
  }

  function buildPeerIdResolveCandidates(rawId) {
    const base = String(rawId || "").trim();
    if (!base) return [];
    const out = [];
    const push = (v) => {
      const s = String(v || "").trim();
      if (s && !out.includes(s)) {
        out.push(s);
      }
    };

    push(base);
    const digits = base.replace(/^-100/, "").replace(/^-/, "");
    if (/^\d+$/.test(digits)) {
      push(`-100${digits}`);
      push(`-${digits}`);
      push(digits);
    }
    return out;
  }

  function loadCacheManifest(cacheContext) {
    if (!cacheContext?.manifestPath || !fs.existsSync(cacheContext.manifestPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(cacheContext.manifestPath, "utf8"));
    } catch {
      return null;
    }
  }

  function persistScanCache(cacheContext, payload) {
    if (!cacheContext?.enabled) return;
    ensureDirExists(cacheContext.rootDir);
    ensureDirExists(cacheContext.mediaDir);
    const nowIso = new Date().toISOString();
    const manifest = {
      schema_version: 1,
      scan_scope: "full",
      created_at: nowIso,
      start_from_id: 0,
      end_at_id: 0,
      start_from_date: "",
      end_at_date: "",
      source_channel_input: sourceChannelInput,
      dest_channel_input: destChannelInput,
      local_archive_dir: localArchiveDir,
      source_peer: payload?.sourcePeer || null,
      destination_peer: payload?.destinationPeer || null
    };
    fs.writeFileSync(cacheContext.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    fs.writeFileSync(cacheContext.scanPath, JSON.stringify(payload?.scan || {}, null, 2), "utf8");
  }

  function cacheMediaFilePath(cacheContext, message) {
    const ext = extensionForMessage(message) || ".bin";
    return path.join(cacheContext.mediaDir, `${Number(message?.id || 0)}${ext}`);
  }

  function getCachedMediaPath(cacheContext, message) {
    if (!cacheContext?.enabled) return "";
    const candidate = cacheMediaFilePath(cacheContext, message);
    if (!candidate || !fs.existsSync(candidate)) {
      return "";
    }
    const size = fileSizeBytesSafe(candidate);
    return size > 0 ? candidate : "";
  }

  function saveMediaToCache(cacheContext, message, media) {
    if (!cacheContext?.enabled || !message?.media || !media) {
      return "";
    }
    ensureDirExists(cacheContext.mediaDir);
    const targetPath = cacheMediaFilePath(cacheContext, message);
    if (!targetPath) {
      return "";
    }
    if (Buffer.isBuffer(media)) {
      fs.writeFileSync(targetPath, media);
      return targetPath;
    }
    if (typeof media === "string" && fs.existsSync(media)) {
      if (path.resolve(media) !== path.resolve(targetPath)) {
        fs.copyFileSync(media, targetPath);
      }
      return targetPath;
    }
    return "";
  }

  return {
    buildFileCacheContext,
    buildPeerIdResolveCandidates,
    deserializeMessageFromCache: syntheticUtils.deserializeMessageFromCache,
    findPairKeyForLocalSource: syntheticUtils.findPairKeyForLocalSource,
    findFallbackSourceCacheBundle,
    getCachedMediaPath,
    isFullScanManifest,
    isTelegramTosPlaceholderMessage: syntheticUtils.isTelegramTosPlaceholderMessage,
    loadCacheManifest,
    loadScanCache,
    loadScanCacheUnchecked,
    loadSyntheticScanFromArchiveDb: syntheticUtils.loadSyntheticScanFromArchiveDb,
    parsePairKeyIds: syntheticUtils.parsePairKeyIds,
    peerFromCacheSnapshot,
    persistScanCache,
    saveMediaToCache,
    serializeMessageForCache: syntheticUtils.serializeMessageForCache,
    snapshotPeerForCache
  };
}

module.exports = {
  createSourceCacheService
};
