"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const initSqlJs = require("sql.js");

function resolveEnvPathFromArgs(rawArgs = []) {
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i] || "").trim();
    if (!arg) continue;
    if (arg === "--env") {
      const next = String(rawArgs[i + 1] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new Error("Missing value for --env. Example: --env .env.alt");
      }
      return path.resolve(next);
    }
    if (arg.startsWith("--env=")) {
      const inline = String(arg.slice("--env=".length) || "").trim();
      if (!inline) {
        throw new Error("Missing value for --env=. Example: --env=.env.alt");
      }
      return path.resolve(inline);
    }
  }
  return "";
}

const ENV_PATH_FROM_CLI = resolveEnvPathFromArgs(process.argv.slice(2));
if (ENV_PATH_FROM_CLI) {
  process.env.DOTENV_CONFIG_PATH = ENV_PATH_FROM_CLI;
  dotenv.config({ path: ENV_PATH_FROM_CLI });
} else {
  dotenv.config();
}

const APPEND_DEST_PERMALINK = /^(1|true)$/i.test(process.env.APPEND_DEST_PERMALINK || "0");
const APPEND_DEST_PERMALINK_TXT = String(process.env.APPEND_DEST_PERMALINK_TXT || "");
const APPEND_DEST_PERMALINK_CHANNEL = String(
  process.env.APPEND_DEST_PERMALINK_CHANNEL || ""
).trim();
const POST_AUTOPREPEND_LINE1 = String(process.env.POST_AUTOPREPEND_LINE1 || "");
const POST_AUTOPREPEND_LINE2 = String(process.env.POST_AUTOPREPEND_LINE2 || "");
const POST_AUTOAPPEND_LINE1 = String(process.env.POST_AUTOAPPEND_LINE1 || "");
const POST_AUTOAPPEND_LINE2 = String(process.env.POST_AUTOAPPEND_LINE2 || "");

function parseCliOptions(rawArgs = []) {
  const options = {
    localArchiveDir: "",
    envFilePath: ""
  };
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i] || "").trim();
    if (!arg) continue;
    if (arg === "--local") {
      const next = String(rawArgs[i + 1] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new Error("Missing value for --local. Example: --local myfolder/channel-archive1");
      }
      options.localArchiveDir = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--local=")) {
      const inline = String(arg.slice("--local=".length) || "").trim();
      if (!inline) {
        throw new Error("Missing value for --local=. Example: --local=myfolder/channel-archive1");
      }
      options.localArchiveDir = inline;
      continue;
    }
    if (arg === "--env") {
      const next = String(rawArgs[i + 1] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new Error("Missing value for --env. Example: --env .env.alt");
      }
      options.envFilePath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--env=")) {
      const inline = String(arg.slice("--env=".length) || "").trim();
      if (!inline) {
        throw new Error("Missing value for --env=. Example: --env=.env.alt");
      }
      options.envFilePath = inline;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(
        `Unknown option "${arg}". Supported options: --local <archive-dir>, --env <file>`
      );
    }
  }
  return options;
}

function toPosixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

function normalizeChannelHandleInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const fromUrl = raw.match(/^(?:https?:\/\/)?t(?:elegram)?\.me\/([A-Za-z0-9_]{5,})(?:\/.*)?$/i);
  if (fromUrl && !String(fromUrl[1] || "").startsWith("+")) {
    return String(fromUrl[1] || "").trim().replace(/^@+/, "").toLowerCase();
  }
  return raw.replace(/^@+/, "").toLowerCase();
}

function decodeEnvEscapes(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

function toDateOnlyStringSafe(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function buildTemplateLines(line1, line2, originalDate) {
  const pattern = /\$\{ORIGINAL_POST_DATE\}/g;
  return [line1, line2]
    .map((line) => decodeEnvEscapes(line))
    .map((line) => line.replace(pattern, originalDate))
    .filter((line) => line.trim().length > 0);
}

function applyHtmlAutoTextLines(text, originalDate) {
  const base = String(text || "");
  const prepend = buildTemplateLines(POST_AUTOPREPEND_LINE1, POST_AUTOPREPEND_LINE2, originalDate);
  const append = buildTemplateLines(POST_AUTOAPPEND_LINE1, POST_AUTOAPPEND_LINE2, originalDate);
  const blocks = [];
  if (prepend.length) blocks.push(prepend.join("\n"));
  if (base.trim().length > 0) blocks.push(base);
  if (append.length) blocks.push(append.join("\n"));
  return blocks.join("\n");
}

function appendPermalinkWithPrefix(text, permalink, prefix) {
  const base = String(text || "");
  const link = String(permalink || "").trim();
  const prefixText = String(prefix || "");
  if (!link) return base;
  if (base.includes(link)) return base;
  const permalinkText = prefixText
    ? `${prefixText}${/\s$/.test(prefixText) ? "" : " "}${link}`
    : link;
  return base.trim().length > 0 ? `${base}\n\n${permalinkText}` : permalinkText;
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function looksLikeImage(ext) {
  return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg"].includes(ext);
}

function looksLikeVideo(ext) {
  return [".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi"].includes(ext);
}

function parseCaptions(captionsSection) {
  const value = String(captionsSection || "").trim();
  if (!value) return [];

  const result = [];
  const re = /#(\d+):\s*([\s\S]*?)(?=(?:\n#\d+:)|$)/g;
  let match = null;
  while ((match = re.exec(value))) {
    const messageId = Number.parseInt(String(match[1] || "0"), 10);
    const text = String(match[2] || "").trim();
    if (!text) continue;
    result.push({
      message_id: Number.isInteger(messageId) ? messageId : 0,
      text
    });
  }
  if (result.length) return result;
  return [{ message_id: 0, text: value }];
}

function parsePostTxt(rawText) {
  const raw = String(rawText || "");
  const lines = raw.split(/\r?\n/);
  const metadata = {};
  let captionsStart = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*captions:\s*$/i.test(line)) {
      captionsStart = i + 1;
      break;
    }
    const match = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (match) {
      metadata[String(match[1]).toLowerCase()] = String(match[2] || "");
    }
  }

  const captionsSection = captionsStart >= 0 ? lines.slice(captionsStart).join("\n") : "";
  const captions = parseCaptions(captionsSection);
  const postBody = captions.map((x) => x.text).filter((x) => x.trim().length > 0).join("\n\n");
  return {
    metadata,
    captions,
    postBody
  };
}

function scanArchive(archiveDir, options = {}) {
  if (!fs.existsSync(archiveDir)) {
    throw new Error(`Archive folder not found: ${archiveDir}`);
  }

  const permalinkByFolder = options.permalinkByFolder instanceof Map
    ? options.permalinkByFolder
    : new Map();

  const posts = [];
  const entries = fs
    .readdirSync(archiveDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const dirName of entries) {
    const absDir = path.join(archiveDir, dirName);
    const postTxtPath = path.join(absDir, "post.txt");
    if (!fs.existsSync(postTxtPath)) {
      continue;
    }

    const postTxtRaw = fs.readFileSync(postTxtPath, "utf8");
    const parsed = parsePostTxt(postTxtRaw);
    const metadata = parsed.metadata;
    const title = String(metadata.title || dirName);
    const originalDate = String(metadata.original_date || "");
    const dateOnly = toDateOnlyStringSafe(originalDate);
    const destinationPermalink = String(permalinkByFolder.get(dirName) || "");
    let postText = applyHtmlAutoTextLines(parsed.postBody, dateOnly);
    if (APPEND_DEST_PERMALINK && destinationPermalink) {
      postText = appendPermalinkWithPrefix(postText, destinationPermalink, APPEND_DEST_PERMALINK_TXT);
    }

    const media = fs
      .readdirSync(absDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase() !== "post.txt")
      .map((e) => {
        const absFile = path.join(absDir, e.name);
        const ext = path.extname(e.name).toLowerCase();
        const relPath = toPosixPath(path.relative(archiveDir, absFile));
        const sizeBytes = fs.statSync(absFile).size;
        const kind = looksLikeImage(ext) ? "image" : looksLikeVideo(ext) ? "video" : "file";
        return {
          name: e.name,
          relative_path: relPath,
          size_bytes: sizeBytes,
          ext,
          kind
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    posts.push({
      folder: dirName,
      title,
      original_date: originalDate,
      message_ids: String(metadata.message_ids || ""),
      message_count: Number.parseInt(String(metadata.message_count || "0"), 10) || 0,
      media_count: Number.parseInt(String(metadata.media_count || String(media.length)), 10) || media.length,
      source_channel_input: String(metadata.source_channel_input || ""),
      post_text: postText,
      destination_permalink: destinationPermalink,
      captions: parsed.captions,
      post_txt_raw: postTxtRaw,
      media
    });
  }

  posts.sort((a, b) => {
    const ta = Date.parse(a.original_date || "");
    const tb = Date.parse(b.original_date || "");
    if (Number.isNaN(ta) && Number.isNaN(tb)) return a.folder.localeCompare(b.folder);
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });

  return {
    generated_at: new Date().toISOString(),
    archive_dir_name: path.basename(archiveDir),
    channel_profile: options.channelProfile || null,
    total_posts: posts.length,
    posts
  };
}

async function loadArchiveDbContext(dbPath, archiveDir, options = {}) {
  const preferredPermalinkChannel = normalizeChannelHandleInput(
    options.preferredPermalinkChannel || ""
  );
  const result = {
    permalinkByFolder: new Map(),
    channelProfile: null,
    permalinkChannelMatched: false,
    permalinkChannelRequested: preferredPermalinkChannel
  };
  if (!fs.existsSync(dbPath)) {
    return result;
  }

  const SQL = await initSqlJs();
  const bytes = fs.readFileSync(dbPath);
  const db = new SQL.Database(bytes);
  let stmt = null;
  try {
    const hasColumn = (tableName, columnName) => {
      const columnsStmt = db.prepare(`PRAGMA table_info(${tableName})`);
      let found = false;
      while (columnsStmt.step()) {
        const row = columnsStmt.getAsObject();
        if (String(row.name || "").trim().toLowerCase() === String(columnName || "").trim().toLowerCase()) {
          found = true;
          break;
        }
      }
      columnsStmt.free();
      return found;
    };

    const hasMetaStmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta' LIMIT 1"
    );
    const hasMeta = hasMetaStmt.step();
    hasMetaStmt.free();
    if (!hasMeta) {
      return result;
    }

    const metaByKey = new Map();
    stmt = db.prepare("SELECT key, value FROM meta");
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const key = String(row.key || "").trim();
      if (!key) continue;
      metaByKey.set(key, String(row.value || ""));
    }
    stmt.free();
    stmt = null;

    const hasDestinationsStmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'destinations' LIMIT 1"
    );
    const hasDestinations = hasDestinationsStmt.step();
    hasDestinationsStmt.free();

    if (hasDestinations && preferredPermalinkChannel) {
      stmt = db.prepare(`
        SELECT
          pair_key,
          destination_title,
          destination_username,
          destination_id,
          destination_icon_data_uri,
          destination_icon_relpath,
          updated_at
        FROM destinations
        WHERE LOWER(COALESCE(TRIM(destination_username), '')) = ?
        ORDER BY updated_at DESC, pair_key ASC
        LIMIT 1
      `);
      stmt.bind([preferredPermalinkChannel]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        result.channelProfile = {
          pair_key: String(row.pair_key || "").trim(),
          title: String(row.destination_title || "").trim(),
          username: String(row.destination_username || "").trim(),
          id: String(row.destination_id || "").trim(),
          icon_data_uri: String(row.destination_icon_data_uri || "").trim(),
          icon_relpath: String(row.destination_icon_relpath || "").trim(),
          updated_at: String(row.updated_at || "").trim()
        };
        result.permalinkChannelMatched = true;
      }
      stmt.free();
      stmt = null;
    }

    if (hasDestinations && !result.channelProfile) {
      stmt = db.prepare(`
        SELECT
          pair_key,
          destination_title,
          destination_username,
          destination_id,
          destination_icon_data_uri,
          destination_icon_relpath,
          updated_at
        FROM destinations
        ORDER BY updated_at DESC, pair_key ASC
        LIMIT 1
      `);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        result.channelProfile = {
          pair_key: String(row.pair_key || "").trim(),
          title: String(row.destination_title || "").trim(),
          username: String(row.destination_username || "").trim(),
          id: String(row.destination_id || "").trim(),
          icon_data_uri: String(row.destination_icon_data_uri || "").trim(),
          icon_relpath: String(row.destination_icon_relpath || "").trim(),
          updated_at: String(row.updated_at || "").trim()
        };
      }
      stmt.free();
      stmt = null;
    }

    const activePairForPermalinks = String(result.channelProfile?.pair_key || "").trim();
    const hasPostDestinationsStmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'post_destinations' LIMIT 1"
    );
    const hasPostDestinations = hasPostDestinationsStmt.step();
    hasPostDestinationsStmt.free();

    if (hasPostDestinations && activePairForPermalinks) {
      stmt = db.prepare(`
        SELECT p.folder_name, pd.destination_permalink
        FROM post_destinations pd
        JOIN posts p
          ON p.pair_key = pd.pair_key
         AND p.primary_source_message_id = pd.primary_source_message_id
        WHERE pd.pair_key = ?
          AND COALESCE(TRIM(pd.destination_permalink), '') != ''
        ORDER BY pd.updated_at DESC
      `);
      stmt.bind([activePairForPermalinks]);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const folder = String(row.folder_name || "").trim();
        const permalink = String(row.destination_permalink || "").trim();
        if (!folder || !permalink) continue;
        if (!result.permalinkByFolder.has(folder)) {
          result.permalinkByFolder.set(folder, permalink);
        }
      }
      stmt.free();
      stmt = null;
    } else if (hasColumn("posts", "destination_permalink")) {
      stmt = db.prepare(`
        SELECT folder_name, destination_permalink
        FROM posts
        WHERE COALESCE(TRIM(destination_permalink), '') != ''
        ORDER BY updated_at DESC, id DESC
      `);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const folder = String(row.folder_name || "").trim();
        const permalink = String(row.destination_permalink || "").trim();
        if (!folder || !permalink) continue;
        if (!result.permalinkByFolder.has(folder)) {
          result.permalinkByFolder.set(folder, permalink);
        }
      }
      stmt.free();
      stmt = null;
    }

    if (!result.channelProfile) {
      let activePairKey = String(metaByKey.get("local2dest_active_pair_key") || "").trim();
      if (!activePairKey) {
        stmt = db.prepare(`
          SELECT pair_key, COUNT(*) AS post_count
          FROM posts
          GROUP BY pair_key
          ORDER BY post_count DESC, pair_key ASC
          LIMIT 1
        `);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          activePairKey = String(row.pair_key || "").trim();
        }
        stmt.free();
        stmt = null;
      }

      if (activePairKey) {
        const pick = (suffix) => String(metaByKey.get(`dest_channel_${suffix}:${activePairKey}`) || "").trim();
        result.channelProfile = {
          pair_key: activePairKey,
          title: pick("title"),
          username: pick("username"),
          id: pick("id"),
          icon_data_uri: pick("icon_data_uri"),
          icon_relpath: pick("icon_relpath"),
          updated_at: pick("updated_at")
        };
      }
    }

    if (result.channelProfile && !result.channelProfile.icon_data_uri && result.channelProfile.icon_relpath) {
      const absIconPath = path.resolve(
        archiveDir,
        result.channelProfile.icon_relpath.split("/").join(path.sep)
      );
      if (!fs.existsSync(absIconPath)) {
        result.channelProfile.icon_relpath = "";
      }
    }
  } finally {
    if (stmt) stmt.free();
    db.close();
  }
  return result;
}

function buildChannelHeaderText(profile) {
  const p = profile || null;
  if (!p) return "Archive Timeline";
  if (String(p.title || "").trim()) return String(p.title).trim();
  if (String(p.username || "").trim()) return `@${String(p.username).trim()}`;
  if (String(p.id || "").trim()) return `Channel ${String(p.id).trim()}`;
  return "Archive Timeline";
}

function detectPrimaryTextDirection(text) {
  const value = String(text || "");
  const rtlMatches =
    value.match(
      /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g
    ) || [];
  const latinMatches = value.match(/[A-Za-z]/g) || [];
  if (rtlMatches.length === 0 && latinMatches.length === 0) return "auto";
  return rtlMatches.length >= latinMatches.length ? "rtl" : "ltr";
}

function renderHtml(data) {
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  const channelHeaderText = buildChannelHeaderText(data.channel_profile);
  const channelTitle = htmlEscape(channelHeaderText);
  const channelHeaderDir = detectPrimaryTextDirection(channelHeaderText);
  const channelHeaderClass = channelHeaderDir === "rtl" ? "rtl" : channelHeaderDir === "ltr" ? "ltr" : "auto";
  const iconDataUri = String(data?.channel_profile?.icon_data_uri || "").trim();
  const iconRelPath = String(data?.channel_profile?.icon_relpath || "").trim();
  const iconSrc = iconDataUri
    ? htmlEscape(iconDataUri)
    : iconRelPath
      ? htmlEscape(encodeURI(iconRelPath))
      : "";
  const faviconMarkup = iconSrc
    ? `<link rel="icon" type="image/png" href="${iconSrc}" />`
    : "";
  const iconMarkup = iconSrc
    ? `<img class="header-icon" src="${iconSrc}" alt="" />`
    : `<div class="header-icon placeholder"></div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${channelTitle}</title>
  ${faviconMarkup}
  <style>
    :root {
      --bg: #d4e6d0;
      --bubble: #ffffff;
      --bubble-border: #c8d8c2;
      --text: #1f2a2d;
      --muted: #6e7f86;
      --accent: #2d8cff;
      --overlay: rgba(0, 0, 0, 0.94);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 20% 10%, #e7f3e4 0%, transparent 30%),
        radial-gradient(circle at 80% 0%, #dcedd7 0%, transparent 26%),
        var(--bg);
    }
    .app {
      width: 100%;
      max-width: 980px;
      margin: 0 auto;
      padding: 14px 10px 26px;
    }
    .header {
      position: sticky;
      top: 0;
      z-index: 2;
      background: rgba(212, 230, 208, 0.9);
      backdrop-filter: blur(4px);
      border-bottom: 1px solid #bed0b8;
      padding: 8px 4px;
      margin-bottom: 10px;
      display: block;
    }
    .header-main {
      display: flex;
      align-items: center;
      gap: 10px;
      width: fit-content;
      max-width: 100%;
    }
    .header-main.rtl {
      direction: rtl;
      flex-direction: row;
      text-align: right;
      margin-left: auto;
    }
    .header-main.ltr {
      direction: ltr;
      flex-direction: row;
      text-align: left;
      margin-right: auto;
    }
    .header-icon {
      width: 34px;
      height: 34px;
      border-radius: 999px;
      object-fit: cover;
      border: 1px solid #bed0b8;
      background: #e4efe0;
      flex: 0 0 34px;
    }
    .header-icon.placeholder {
      display: inline-block;
      background: linear-gradient(135deg, #d9e7d4, #c7d8c2);
    }
    .header h1 {
      font-size: 18px;
      margin: 0;
      font-weight: 700;
      flex: 0 0 auto;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
    }
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .post {
      background: var(--bubble);
      border: 1px solid var(--bubble-border);
      border-radius: 12px;
      padding: 12px 12px 10px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    }
    .post-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .title {
      font-weight: 700;
      font-size: 14px;
      word-break: break-word;
    }
    .date {
      color: var(--muted);
      white-space: nowrap;
    }
    .head-right {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
      justify-content: flex-end;
    }
    .permalink {
      color: var(--accent);
      text-decoration: none;
      font-size: 13px;
      line-height: 1;
      border: 1px solid #b6d5ff;
      border-radius: 999px;
      padding: 1px 7px;
      background: #eef6ff;
    }
    .permalink:hover {
      background: #deefff;
    }
    .post:target {
      box-shadow: 0 0 0 2px #8ec5ff;
    }
    .text {
      line-height: 1.45;
      font-size: 16px;
      word-break: break-word;
      margin-bottom: 10px;
    }
    .text-line {
      white-space: pre-wrap;
    }
    .text-line:empty::before {
      content: "\\00a0";
    }
    .text-line.url-line {
      direction: ltr;
      text-align: left;
      unicode-bidi: isolate;
      word-break: break-all;
    }
    .text-link {
      color: var(--accent);
      text-decoration: underline;
      text-underline-offset: 2px;
      word-break: break-all;
    }
    .flag-emoji {
      display: inline-block;
      width: 1.15em;
      height: 0.85em;
      vertical-align: -0.08em;
      border-radius: 2px;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.15) inset;
      margin: 0 0.08em;
    }
    .rtl {
      direction: rtl;
      text-align: right;
    }
    .ltr {
      direction: ltr;
      text-align: left;
    }
    .media-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
      direction: ltr;
      justify-items: stretch;
      align-items: stretch;
    }
    .media-grid.media-cols-2 { grid-template-columns: repeat(2, minmax(150px, 1fr)); }
    .media-grid.media-cols-3 { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
    .media-grid.media-cols-4 { grid-template-columns: repeat(4, minmax(150px, 1fr)); }
    .media-grid.media-cols-5 { grid-template-columns: repeat(5, minmax(150px, 1fr)); }
    .media-grid.single-media {
      grid-template-columns: minmax(180px, 320px);
      justify-content: start;
    }
    .media-grid.exact-ten-media {
      grid-template-columns: repeat(5, minmax(150px, 1fr));
    }
    .media-item {
      border: 1px solid #dce4d8;
      border-radius: 10px;
      overflow: hidden;
      background: #eff6ec;
      cursor: pointer;
      position: relative;
      min-height: 110px;
    }
    .media-item img, .media-item video {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      background: #d9e8d5;
    }
    .media-file-link {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 10px;
      text-align: center;
      font-size: 13px;
      text-decoration: none;
      color: #264653;
      background: #ebf5e8;
      word-break: break-all;
    }
    .media-badge {
      position: absolute;
      right: 6px;
      bottom: 6px;
      background: rgba(0, 0, 0, 0.65);
      color: #fff;
      font-size: 11px;
      border-radius: 8px;
      padding: 2px 6px;
    }
    .post-foot {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .overlay {
      position: fixed;
      inset: 0;
      height: 100vh;
      height: 100dvh;
      background: var(--overlay);
      z-index: 30;
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    .overlay.open {
      display: flex;
    }
    .overlay-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #d7dee2;
      padding: 8px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.15);
      font-size: 13px;
    }
    .btn {
      border: 1px solid rgba(255,255,255,0.35);
      background: rgba(255,255,255,0.12);
      color: #fff;
      border-radius: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 13px;
    }
    .viewer {
      flex: 1;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 14px;
      position: relative;
      overflow: hidden;
    }
    .viewer img, .viewer video {
      max-width: 100%;
      max-height: calc(100vh - 96px);
      max-height: calc(100dvh - 96px);
      width: auto;
      height: auto;
      object-fit: contain;
      border-radius: 10px;
      background: #000;
    }
    .nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      border: none;
      background: rgba(0,0,0,0.45);
      color: #fff;
      width: 42px;
      height: 42px;
      border-radius: 999px;
      cursor: pointer;
      font-size: 24px;
      line-height: 1;
    }
    .nav.prev { left: 14px; }
    .nav.next { right: 14px; }
    .empty {
      color: #2d3b3f;
      opacity: 0.8;
      text-align: center;
      padding: 40px 10px;
    }
    .load-more {
      color: var(--muted);
      text-align: center;
      padding: 12px 8px 6px;
      font-size: 13px;
    }
    .load-more.done {
      opacity: 0.75;
    }
    @media (max-width: 700px) {
      .app { padding: 10px 6px 20px; }
      .text { font-size: 15px; }
      .media-grid { grid-template-columns: repeat(2, 1fr); }
      .media-grid.media-cols-2,
      .media-grid.media-cols-3,
      .media-grid.media-cols-4,
      .media-grid.media-cols-5 { grid-template-columns: repeat(2, 1fr); }
      .media-grid.exact-ten-media { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="header">
      <div class="header-main ${channelHeaderClass}" dir="${channelHeaderDir}">
        ${iconMarkup}
        <h1>${channelTitle}</h1>
      </div>
    </div>
    <div class="timeline" id="timeline"></div>
  </div>

  <div class="overlay" id="overlay">
    <div class="overlay-top">
      <div id="overlayMeta"></div>
      <button class="btn" id="closeBtn" type="button">Close</button>
    </div>
    <div class="viewer" id="viewer">
      <button class="nav prev" id="prevBtn" type="button" aria-label="Previous">‹</button>
      <button class="nav next" id="nextBtn" type="button" aria-label="Next">›</button>
    </div>
  </div>

  <script id="archive-data" type="application/json">${dataJson}</script>
  <script>
    (() => {
      const data = JSON.parse(document.getElementById("archive-data").textContent);
      const timeline = document.getElementById("timeline");
      const overlay = document.getElementById("overlay");
      const overlayMeta = document.getElementById("overlayMeta");
      const viewer = document.getElementById("viewer");
      const closeBtn = document.getElementById("closeBtn");
      const prevBtn = document.getElementById("prevBtn");
      const nextBtn = document.getElementById("nextBtn");
      const LAZY_BATCH_SIZE = 20;
      const loadMoreEl = document.createElement("div");
      loadMoreEl.className = "load-more";

      let activeMedia = [];
      let activeIndex = 0;
      let activeTitle = "";
      let lazyPosts = [];
      let lazyCursor = 0;
      let lazyLoading = false;

      function formatBytes(n) {
        const value = Number(n || 0);
        if (value < 1024) return value + " B";
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
        if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
        return (value / (1024 * 1024 * 1024)).toFixed(2) + " GB";
      }

      function formatDate(iso) {
        const d = new Date(iso);
        if (!iso || Number.isNaN(d.getTime())) return "n/a";
        return d.toLocaleString();
      }

      function rtlScore(text) {
        const value = String(text || "");
        const rtlMatches = value.match(/[\\u0590-\\u05FF\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]/g) || [];
        return rtlMatches.length;
      }

      function latinScore(text) {
        const value = String(text || "");
        const latinMatches = value.match(/[A-Za-z]/g) || [];
        return latinMatches.length;
      }

      function stripUrls(text) {
        return String(text || "").replace(/https?:\\/\\/\\S+/gi, " ");
      }

      function detectDirection(text) {
        const value = String(text || "");
        const rtl = rtlScore(value);
        const latin = latinScore(value);
        if (rtl === 0 && latin === 0) return "auto";
        return rtl > latin ? "rtl" : "ltr";
      }

      function detectPostDirection(text) {
        const withoutUrls = stripUrls(String(text || ""));
        for (const ch of withoutUrls) {
          if (/[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u.test(ch)) {
            return "rtl";
          }
          if (/[A-Za-z]/.test(ch)) {
            return "ltr";
          }
        }
        const rtl = rtlScore(withoutUrls);
        const latin = latinScore(withoutUrls);
        if (rtl === 0 && latin === 0) return "auto";
        return rtl >= latin ? "rtl" : "ltr";
      }

      function isUrlOnlyLine(text) {
        const value = String(text || "").trim();
        return /^https?:\\/\\/\\S+$/i.test(value);
      }

      function replaceKnownCountryCodesWithFlags(text) {
        return String(text || "");
      }

      function flagSvgDataUri(countryCode) {
        const code = String(countryCode || "").toUpperCase();
        let svg = "";
        if (code === "NL") {
          svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 20'><rect width='30' height='20' fill='#fff'/><rect width='30' height='6.67' y='0' fill='#ae1c28'/><rect width='30' height='6.67' y='13.33' fill='#21468b'/></svg>";
        } else if (code === "BE") {
          svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 20'><rect width='10' height='20' x='0' fill='#000'/><rect width='10' height='20' x='10' fill='#ffd90c'/><rect width='10' height='20' x='20' fill='#ef3340'/></svg>";
        }
        if (!svg) return "";
        return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
      }

      function appendTextWithFlags(container, text) {
        const value = String(text || "");
        const re = /(🇳🇱|🇧🇪)/gu;
        let last = 0;
        let match = null;
        while ((match = re.exec(value))) {
          const start = match.index;
          const end = start + String(match[0] || "").length;
          if (start > last) {
            container.appendChild(document.createTextNode(value.slice(last, start)));
          }
          const token = String(match[0] || "");
          let code = "";
          if (token === "🇳🇱") code = "NL";
          if (token === "🇧🇪") code = "BE";
          const src = flagSvgDataUri(code);
          if (src) {
            const img = document.createElement("img");
            img.className = "flag-emoji";
            img.src = src;
            img.alt = code;
            img.title = code;
            container.appendChild(img);
          } else {
            container.appendChild(document.createTextNode(match[0]));
          }
          last = end;
        }
        if (last < value.length) {
          container.appendChild(document.createTextNode(value.slice(last)));
        }
      }

      function appendLinkifiedNodes(container, line) {
        const value = String(line || "");
        const re = /https?:\\/\\/\\S+/gi;
        let last = 0;
        let match = null;
        while ((match = re.exec(value))) {
          const start = match.index;
          const end = start + String(match[0] || "").length;
          if (start > last) {
            appendTextWithFlags(container, value.slice(last, start));
          }
          const url = String(match[0] || "");
          const a = document.createElement("a");
          a.className = "text-link";
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = url;
          container.appendChild(a);
          last = end;
        }
        if (last < value.length) {
          appendTextWithFlags(container, value.slice(last));
        }
      }

      function renderTextLines(container, text, defaultDir) {
        const value = String(text || "").replace(/\\r\\n?/g, "\\n");
        const lines = value.split("\\n");
        for (const line of lines) {
          const lineEl = document.createElement("div");
          lineEl.className = "text-line";
          if (isUrlOnlyLine(line)) {
            lineEl.classList.add("url-line");
            lineEl.dir = "ltr";
            appendLinkifiedNodes(lineEl, line.trim());
          } else {
            const dir = detectDirection(line);
            const effectiveDir = dir === "auto" ? (defaultDir || "auto") : dir;
            lineEl.dir = effectiveDir;
            if (effectiveDir === "rtl") {
              lineEl.classList.add("rtl");
            } else if (effectiveDir === "ltr") {
              lineEl.classList.add("ltr");
            }
            appendLinkifiedNodes(lineEl, line);
          }
          container.appendChild(lineEl);
        }
      }

      function clearViewer() {
        for (const node of Array.from(viewer.querySelectorAll(".media-render"))) {
          node.remove();
        }
      }

      function renderOverlayItem() {
        if (!activeMedia.length) return;
        clearViewer();
        const item = activeMedia[activeIndex];
        const src = encodeURI(item.relative_path);
        let el = null;
        if (item.kind === "video") {
          el = document.createElement("video");
          el.src = src;
          el.controls = true;
          el.autoplay = false;
          el.className = "media-render";
        } else {
          el = document.createElement("img");
          el.src = src;
          el.alt = item.name || "";
          el.className = "media-render";
        }
        viewer.appendChild(el);
        overlayMeta.textContent = activeTitle + "  |  " + (activeIndex + 1) + "/" + activeMedia.length;
      }

      function openOverlay(mediaItems, startIndex, title) {
        activeMedia = Array.isArray(mediaItems) ? mediaItems.slice() : [];
        activeIndex = Math.max(0, Math.min(Number(startIndex || 0), Math.max(0, activeMedia.length - 1)));
        activeTitle = String(title || "Media");
        if (!activeMedia.length) return;
        overlay.classList.add("open");
        renderOverlayItem();
      }

      function closeOverlay() {
        overlay.classList.remove("open");
        activeMedia = [];
        activeIndex = 0;
        activeTitle = "";
        clearViewer();
      }

      function shiftOverlay(delta) {
        if (!activeMedia.length) return;
        activeIndex = (activeIndex + delta + activeMedia.length) % activeMedia.length;
        renderOverlayItem();
      }

      function buildPostCard(post, postIndex) {
        const anchor = "post-" + String(post.folder || String(postIndex + 1))
          .replace(/[^a-zA-Z0-9_-]+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "");
        const card = document.createElement("article");
        card.className = "post";
        card.id = anchor;

        const head = document.createElement("div");
        head.className = "post-head";
        const dateEl = document.createElement("div");
        dateEl.className = "date";
        dateEl.textContent = formatDate(post.original_date);
        const right = document.createElement("div");
        right.className = "head-right";
        const linkEl = document.createElement("a");
        linkEl.className = "permalink";
        linkEl.href = "#" + anchor;
        linkEl.textContent = "#";
        linkEl.title = "Permalink to this post";
        right.appendChild(dateEl);
        right.appendChild(linkEl);
        head.appendChild(right);
        card.appendChild(head);
        const dir = detectPostDirection(String(post.post_text || ""));

        const media = Array.isArray(post.media) ? post.media : [];
        if (media.length) {
          const grid = document.createElement("div");
          grid.className = "media-grid";
          if (media.length === 1) {
            grid.classList.add("single-media");
          } else if (media.length === 10) {
            grid.classList.add("exact-ten-media");
          } else {
            const preferredColumnsByCount = {
              2: 2,
              3: 3,
              4: 2,
              5: 3,
              6: 3,
              7: 4,
              8: 4,
              9: 3
            };
            const preferred = preferredColumnsByCount[media.length];
            if (preferred) {
              grid.classList.add("media-cols-" + preferred);
            }
          }
          media.forEach((m, idx) => {
            const item = document.createElement("div");
            item.className = "media-item";

            if (m.kind === "image") {
              const img = document.createElement("img");
              img.loading = "lazy";
              img.src = encodeURI(m.relative_path);
              img.alt = m.name || "";
              item.appendChild(img);
            } else if (m.kind === "video") {
              const vid = document.createElement("video");
              vid.preload = "metadata";
              vid.src = encodeURI(m.relative_path);
              vid.controls = false;
              vid.muted = true;
              vid.playsInline = true;
              item.appendChild(vid);
            } else {
              const a = document.createElement("a");
              a.className = "media-file-link";
              a.href = encodeURI(m.relative_path);
              a.textContent = m.name || m.relative_path;
              a.target = "_blank";
              a.rel = "noopener";
              item.appendChild(a);
            }

            const badge = document.createElement("div");
            badge.className = "media-badge";
            badge.textContent = formatBytes(m.size_bytes || 0);
            item.appendChild(badge);

            if (m.kind === "image" || m.kind === "video") {
              item.addEventListener("click", () => openOverlay(media, idx, post.title || "Media"));
            }

            grid.appendChild(item);
          });
          card.appendChild(grid);
        }

        const body = document.createElement("div");
        body.className = "text";
        body.textContent = "";
        body.dir = dir;
        if (dir === "rtl") {
          body.classList.add("rtl");
        } else if (dir === "ltr") {
          body.classList.add("ltr");
        }
        renderTextLines(body, String(post.post_text || ""), dir);
        card.appendChild(body);

        const foot = document.createElement("div");
        foot.className = "post-foot";
        const folderMeta = document.createElement("span");
        folderMeta.textContent = "folder: " + String(post.folder || "");
        const messageMeta = document.createElement("span");
        messageMeta.textContent = "messages: " + String(post.message_count || 0);
        const mediaMeta = document.createElement("span");
        mediaMeta.textContent = "media: " + String(post.media_count || 0);
        foot.appendChild(folderMeta);
        foot.appendChild(messageMeta);
        foot.appendChild(mediaMeta);
        card.appendChild(foot);
        return card;
      }

      function updateLoadMoreUi() {
        if (lazyCursor >= lazyPosts.length) {
          loadMoreEl.textContent = "All posts loaded";
          loadMoreEl.classList.add("done");
          return;
        }
        loadMoreEl.classList.remove("done");
        loadMoreEl.textContent = "Loading more posts...";
      }

      function renderNextBatch() {
        if (lazyLoading) return;
        if (lazyCursor >= lazyPosts.length) {
          updateLoadMoreUi();
          return;
        }
        lazyLoading = true;
        const end = Math.min(lazyPosts.length, lazyCursor + LAZY_BATCH_SIZE);
        for (let i = lazyCursor; i < end; i += 1) {
          const card = buildPostCard(lazyPosts[i], i);
          timeline.insertBefore(card, loadMoreEl);
        }
        lazyCursor = end;
        updateLoadMoreUi();
        lazyLoading = false;
      }

      function renderTimeline() {
        const posts = Array.isArray(data.posts) ? data.posts : [];
        if (!posts.length) {
          timeline.innerHTML = "<div class=\\"empty\\">No archived posts found.</div>";
          return;
        }
        timeline.innerHTML = "";
        lazyPosts = posts;
        lazyCursor = 0;
        timeline.appendChild(loadMoreEl);
        renderNextBatch();

        if ("IntersectionObserver" in window) {
          const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              renderNextBatch();
            }
          }, { rootMargin: "300px 0px" });
          observer.observe(loadMoreEl);
        } else {
          window.addEventListener("scroll", () => {
            const rect = loadMoreEl.getBoundingClientRect();
            if (rect.top <= window.innerHeight + 240) {
              renderNextBatch();
            }
          }, { passive: true });
        }
      }

      closeBtn.addEventListener("click", closeOverlay);
      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) closeOverlay();
      });
      prevBtn.addEventListener("click", () => shiftOverlay(-1));
      nextBtn.addEventListener("click", () => shiftOverlay(1));
      document.addEventListener("keydown", (ev) => {
        if (!overlay.classList.contains("open")) return;
        if (ev.key === "Escape") closeOverlay();
        if (ev.key === "ArrowLeft") shiftOverlay(-1);
        if (ev.key === "ArrowRight") shiftOverlay(1);
      });

      renderTimeline();
    })();
  </script>
</body>
</html>`;
}

async function main() {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const archiveDir = path.resolve(cliOptions.localArchiveDir || "channel-archive");
  const outputHtml = path.join(archiveDir, "index.html");
  const archiveDbPath = path.join(archiveDir, "archive.db");
  const dbContext = await loadArchiveDbContext(archiveDbPath, archiveDir, {
    preferredPermalinkChannel: APPEND_DEST_PERMALINK_CHANNEL
  });
  const data = scanArchive(archiveDir, {
    permalinkByFolder: dbContext.permalinkByFolder,
    channelProfile: dbContext.channelProfile
  });
  const html = renderHtml(data);
  fs.writeFileSync(outputHtml, html, "utf8");
  console.log(`[local2web-static-js] generated: ${outputHtml}`);
  console.log(`[local2web-static-js] posts: ${data.total_posts}`);
  if (APPEND_DEST_PERMALINK_CHANNEL) {
    const mode = dbContext.permalinkChannelMatched ? "matched" : "fallback-latest";
    console.log(
      `[local2web-static-js] permalink_channel=${APPEND_DEST_PERMALINK_CHANNEL} mode=${mode}`
    );
  }
}

main().catch((error) => {
  console.error(`[local2web-static-js] fatal: ${error?.message || error}`);
  process.exitCode = 1;
});
