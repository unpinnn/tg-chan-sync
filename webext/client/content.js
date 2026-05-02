"use strict";

const state = {
  running: false,
  status: "idle",
  config: null,
  overlay: null,
  hintEl: null,
  statusEl: null,
  historyEl: null,
  overlayExpanded: false,
  statusHistory: [],
  lastJobId: 0
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMsRange(rawValue, fallback) {
  const text = String(rawValue || "").trim();
  const fallbackObj = fallback || { min: 1800, max: 3200 };
  const rangeMatch = text.match(/^(\d+)\s*[-:.,]{1,2}\s*(\d+)$/);
  if (!rangeMatch) return fallbackObj;
  let min = Number.parseInt(rangeMatch[1], 10);
  let max = Number.parseInt(rangeMatch[2], 10);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return fallbackObj;
  min = Math.max(0, min);
  max = Math.max(0, max);
  if (min > max) {
    const tmp = min;
    min = max;
    max = tmp;
  }
  return { min, max };
}

function randomInRange(range) {
  const min = Number(range?.min || 0);
  const max = Number(range?.max || min);
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function runtimeRequest(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "unknown extension error"));
        return;
      }
      resolve(response);
    });
  });
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

function formatError(error) {
  return String(error?.message || error || "unknown error");
}

function appendStatusHistory(line) {
  const text = String(line || "").trim();
  if (!text) return;
  const stamp = new Date().toISOString().slice(11, 19);
  state.statusHistory.push(`${stamp} ${text}`);
  if (state.statusHistory.length > 30) {
    state.statusHistory = state.statusHistory.slice(state.statusHistory.length - 30);
  }
}

function updateOverlayHistory() {
  if (!state.historyEl) return;
  state.historyEl.textContent = state.statusHistory.slice(-10).join("\n");
}

function setOverlayExpanded(expanded) {
  state.overlayExpanded = !!expanded;
  if (!state.overlay || !state.historyEl || !state.hintEl) return;
  state.historyEl.style.display = state.overlayExpanded ? "block" : "none";
  state.hintEl.textContent = state.overlayExpanded ? "click to collapse" : "click to expand";
  state.overlay.style.maxWidth = state.overlayExpanded ? "520px" : "360px";
}

async function sendLogEvent(level, statusText, extra = "") {
  if (!state.config) return;
  const config = state.config;
  const base = normalizeBaseUrl(config.serverBaseUrl);
  const url = `${base}/logs?token=${encodeURIComponent(String(config.token || ""))}`;
  await runtimeRequest({
    type: "XWEB_HTTP",
    request: {
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        level: String(level || "info"),
        status: String(statusText || ""),
        job_id: Number.isInteger(state.lastJobId) ? state.lastJobId : 0,
        tab_id: 0,
        extra: String(extra || "")
      }),
      responseType: "json"
    }
  }).catch(() => {
    // avoid recursion on log transport failures
  });
}

function logStatus(text, options = {}) {
  state.status = String(text || "").trim();
  const level = String(options.level || "info").toLowerCase();
  if (state.statusEl) {
    state.statusEl.textContent = `[xwebext] ${state.status}`;
  }
  const line = `[xwebext] ${state.status}`;
  appendStatusHistory(line);
  updateOverlayHistory();
  if (level === "error") {
    console.error(line);
  } else if (level === "warn" || level === "warning") {
    console.warn(line);
  } else {
    console.log(line);
  }
  sendLogEvent(level, state.status, options.extra || "");
}

async function waitNextAction(config, reason) {
  const waitRange = parseMsRange(config?.postIntervalMsRange, { min: 1800, max: 3200 });
  const ms = randomInRange(waitRange);
  logStatus(`${reason} (next in ${ms}ms)`, { level: "info" });
  await sleep(ms);
}

function ensureOverlay() {
  if (state.overlay && document.body.contains(state.overlay)) return;
  const container = document.createElement("div");
  container.id = "xwebext-overlay";
  container.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "z-index:999999",
    "background:#111",
    "color:#eee",
    "padding:10px 12px",
    "border-radius:10px",
    "font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
    "box-shadow:0 8px 24px rgba(0,0,0,0.4)",
    "max-width:360px",
    "cursor:pointer"
  ].join(";");
  const title = document.createElement("div");
  title.textContent = "Local2X Webext";
  title.style.fontWeight = "700";
  title.style.marginBottom = "6px";
  const status = document.createElement("div");
  status.textContent = "[xwebext] idle";
  status.style.whiteSpace = "pre-wrap";
  const hint = document.createElement("div");
  hint.style.cssText = "margin-top:6px;color:#9ad0ff;font-size:11px;opacity:0.9";
  hint.textContent = "click to expand";
  const history = document.createElement("pre");
  history.style.cssText = [
    "margin:8px 0 0",
    "padding:8px",
    "background:#1b1b1b",
    "border-radius:6px",
    "max-height:200px",
    "overflow:auto",
    "display:none",
    "white-space:pre-wrap",
    "font:11px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace"
  ].join(";");
  history.textContent = "";
  container.appendChild(title);
  container.appendChild(status);
  container.appendChild(hint);
  container.appendChild(history);
  document.body.appendChild(container);
  state.overlay = container;
  state.hintEl = hint;
  state.statusEl = status;
  state.historyEl = history;
  container.addEventListener("click", () => setOverlayExpanded(!state.overlayExpanded));
  setOverlayExpanded(false);
}

async function apiFetch(config, endpoint, options = {}) {
  const base = normalizeBaseUrl(config.serverBaseUrl);
  const url = `${base}${endpoint}${endpoint.includes("?") ? "&" : "?"}token=${encodeURIComponent(
    String(config.token || "")
  )}`;
  const response = await runtimeRequest({
    type: "XWEB_HTTP",
    request: {
      url,
      method: String(options.method || "GET").toUpperCase(),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      body: options.body == null ? undefined : options.body,
      responseType: "json"
    }
  });
  const json = response?.json || {};
  if (!response.httpOk || json?.ok === false) {
    throw new Error(json?.error || `HTTP ${response.status}`);
  }
  return json;
}

function splitTextForX(text, maxLen) {
  const value = String(text || "").replace(/\r\n/g, "\n");
  if (!value.trim()) return [];
  if (value.length <= maxLen) return [value];
  const out = [];
  let rest = value;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < Math.floor(maxLen * 0.5)) cut = rest.lastIndexOf(" ", maxLen);
    if (cut < Math.floor(maxLen * 0.4)) cut = maxLen;
    const chunk = rest.slice(0, cut).trimEnd();
    out.push(chunk);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) out.push(rest);
  return out;
}

function splitMediaBatches(mediaItems = []) {
  const photos = [];
  const singles = [];
  for (const item of mediaItems) {
    const mime = String(item?.mime_type || "").toLowerCase();
    if (mime.startsWith("image/") && mime !== "image/gif") {
      photos.push(item);
    } else {
      singles.push([item]);
    }
  }
  const photoGroups = [];
  for (let i = 0; i < photos.length; i += 4) {
    photoGroups.push(photos.slice(i, i + 4));
  }
  return [...photoGroups, ...singles];
}

async function resolveComposerEditor() {
  const selectors = [
    "div[data-testid='tweetTextarea_0']",
    "div[data-testid='tweetTextarea_0'] div[role='textbox']",
    "div[role='textbox'][contenteditable='true']"
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

async function ensureComposerOpen() {
  let editor = await resolveComposerEditor();
  if (editor) return editor;

  const openSelectors = [
    "[data-testid='SideNav_NewTweet_Button']",
    "button[data-testid='tweetButtonInline']",
    "a[href='/compose/post']"
  ];
  for (const selector of openSelectors) {
    const button = document.querySelector(selector);
    if (!button) continue;
    button.click();
    await sleep(800);
    editor = await resolveComposerEditor();
    if (editor) return editor;
  }
  throw new Error("Could not open X composer from page.");
}

function setCaretToEnd(editor) {
  editor.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function nudgeComposerActivity(editor) {
  // Some X sessions keep Post disabled until typing is observed.
  setCaretToEnd(editor);
  document.execCommand("insertText", false, "az");
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(80);
  document.execCommand("delete", false);
  document.execCommand("delete", false);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function clearComposerText(editor) {
  editor.focus();
  document.execCommand("selectAll", false);
  document.execCommand("delete", false);
}

function findFileInput() {
  return (
    document.querySelector("input[data-testid='fileInput']") ||
    document.querySelector("input[type='file']")
  );
}

async function fetchMediaAsFiles(_config, mediaItems = []) {
  const files = [];
  for (const media of mediaItems) {
    const url = String(media?.url || "").trim();
    if (!url) continue;
    const res = await runtimeRequest({
      type: "XWEB_HTTP",
      request: {
        url,
        method: "GET",
        responseType: "arrayBuffer"
      }
    });
    if (!res.httpOk) throw new Error(`Failed media fetch: ${res.status}`);
    const blob = new Blob([res.arrayBuffer], { type: res.contentType || media?.mime_type || "" });
    const fileName = String(media?.file_name || `media-${media?.index || files.length}`).trim();
    files.push(new File([blob], fileName, { type: blob.type || media?.mime_type || "" }));
  }
  return files;
}

async function attachFiles(config, mediaItems = []) {
  if (!mediaItems.length) return;
  const input = findFileInput();
  if (!input) throw new Error("Composer file input not found.");
  const files = await fetchMediaAsFiles(config, mediaItems);
  const dt = new DataTransfer();
  for (const file of files) dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(1200);
}

function findPostButton() {
  return (
    document.querySelector("button[data-testid='tweetButton']") ||
    document.querySelector("button[data-testid='tweetButtonInline']")
  );
}

async function sendOnePost(config, payload) {
  const editor = await ensureComposerOpen();
  clearComposerText(editor);

  const text = String(payload?.text || "");
  if (text) {
    editor.focus();
    document.execCommand("insertText", false, text);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const mediaItems = Array.isArray(payload?.media) ? payload.media : [];
  await attachFiles(config, mediaItems);

  const postButton = findPostButton();
  if (!postButton) throw new Error("Post button not found.");
  const startedAt = Date.now();
  const enableTimeoutMs = 30000;
  let nextNudgeAt = startedAt + 2500;
  while (Date.now() - startedAt < enableTimeoutMs) {
    const disabled = !!postButton.disabled || postButton.getAttribute("aria-disabled") === "true";
    if (!disabled) break;
    if (Date.now() >= nextNudgeAt) {
      await nudgeComposerActivity(editor);
      nextNudgeAt = Date.now() + 2500;
    }
    await sleep(250);
  }
  if (postButton.disabled || postButton.getAttribute("aria-disabled") === "true") {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    throw new Error(`Post button disabled (timeout waiting enabled after ${elapsedSec}s).`);
  }
  postButton.click();
  await sleep(1800);
}

async function processJob(config, job) {
  state.lastJobId = Number.parseInt(String(job?.id || 0), 10) || 0;
  const textChunks = splitTextForX(job?.text || "", Number(config.maxTextLength || 260));
  const mediaGroups = splitMediaBatches(job?.media || []);

  if (mediaGroups.length > 0) {
    for (let i = 0; i < mediaGroups.length; i += 1) {
      const text = i === 0 ? String(textChunks.shift() || "") : "";
      logStatus(`posting job #${job.id} media group ${i + 1}/${mediaGroups.length}`, {
        level: "info"
      });
      await sendOnePost(config, { text, media: mediaGroups[i] });
      await waitNextAction(config, "posted media group");
    }
  }

  for (let i = 0; i < textChunks.length; i += 1) {
    logStatus(`posting job #${job.id} text part ${i + 1}/${textChunks.length}`, { level: "info" });
    await sendOnePost(config, { text: textChunks[i], media: [] });
    await waitNextAction(config, "posted text part");
  }
}

async function runLoop(config) {
  if (state.running) return;
  state.running = true;
  state.config = config;
  state.lastJobId = 0;
  ensureOverlay();
  logStatus("started", { level: "info" });

  while (state.running) {
    try {
      const next = await apiFetch(config, "/jobs/next", { method: "GET" });
      const job = next?.job || null;
      if (!job) {
        logStatus("idle: no pending jobs", { level: "info" });
        await sleep(config.pollMs);
        continue;
      }

      logStatus(`processing #${job.id} (${job.media_count} media)`, { level: "info" });
      try {
        await processJob(config, job);
        await apiFetch(config, `/jobs/${job.id}/complete`, { method: "POST", body: "{}" });
        logStatus(`completed #${job.id}`, { level: "info" });
        await waitNextAction(config, "job completed");
      } catch (jobError) {
        await apiFetch(config, `/jobs/${job.id}/fail`, {
          method: "POST",
          body: JSON.stringify({ reason: formatError(jobError) })
        });
        logStatus(`failed #${job.id}: ${formatError(jobError)}`, { level: "error" });
        await waitNextAction(config, "job failed");
      }
    } catch (loopError) {
      logStatus(`loop error: ${formatError(loopError)}`, { level: "error" });
      await sleep(Math.max(1500, config.pollMs));
    }
  }

  logStatus("stopped", { level: "info" });
}

function stopLoop() {
  state.running = false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = String(message?.type || "");
  if (type === "XWEB_START") {
    const config = {
      serverBaseUrl: normalizeBaseUrl(message?.config?.serverBaseUrl || "http://127.0.0.1:37891"),
      token: String(message?.config?.token || ""),
      pollMs: Math.max(500, Number.parseInt(String(message?.config?.pollMs || 1500), 10) || 1500),
      maxTextLength: Math.max(
        40,
        Math.min(280, Number.parseInt(String(message?.config?.maxTextLength || 260), 10) || 260)
      ),
      postIntervalMsRange: String(message?.config?.postIntervalMsRange || "1800-3200").trim()
    };
    runLoop(config).catch((error) => {
      logStatus(`fatal: ${formatError(error)}`, { level: "error" });
      stopLoop();
    });
    sendResponse({ ok: true, running: true });
    return true;
  }
  if (type === "XWEB_STOP") {
    stopLoop();
    sendResponse({ ok: true, running: false });
    return true;
  }
  if (type === "XWEB_STATUS") {
    sendResponse({ ok: true, running: state.running, status: state.status });
    return true;
  }
  return false;
});

ensureOverlay();
