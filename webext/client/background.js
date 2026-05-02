"use strict";

const DEFAULT_CONFIG = {
  serverBaseUrl: "http://127.0.0.1:37891",
  token: "",
  pollMs: 1500,
  maxTextLength: 260,
  postIntervalMsRange: "1800-3200"
};

function normalizeMsRange(rawValue, fallback = "1800-3200") {
  const text = String(rawValue || "").trim();
  if (!text) return fallback;
  const rangeMatch = text.match(/^(\d+)\s*[-:.,]{1,2}\s*(\d+)$/);
  if (!rangeMatch) return fallback;
  let min = Number.parseInt(rangeMatch[1], 10);
  let max = Number.parseInt(rangeMatch[2], 10);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return fallback;
  min = Math.max(0, min);
  max = Math.max(0, max);
  if (min > max) {
    const tmp = min;
    min = max;
    max = tmp;
  }
  return `${min}-${max}`;
}

async function getConfig() {
  const data = await chrome.storage.local.get(["xwebext_config"]);
  return { ...DEFAULT_CONFIG, ...(data.xwebext_config || {}) };
}

async function saveConfig(config) {
  const normalized = {
    serverBaseUrl: String(config?.serverBaseUrl || DEFAULT_CONFIG.serverBaseUrl).trim(),
    token: String(config?.token || "").trim(),
    pollMs: Math.max(500, Number.parseInt(String(config?.pollMs || DEFAULT_CONFIG.pollMs), 10) || 1500),
    maxTextLength: Math.max(
      40,
      Math.min(280, Number.parseInt(String(config?.maxTextLength || DEFAULT_CONFIG.maxTextLength), 10) || 260)
    ),
    postIntervalMsRange: normalizeMsRange(
      config?.postIntervalMsRange || DEFAULT_CONFIG.postIntervalMsRange,
      DEFAULT_CONFIG.postIntervalMsRange
    )
  };
  await chrome.storage.local.set({ xwebext_config: normalized });
  return normalized;
}

async function getXTab() {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (tabs.length > 0) return tabs[0];
  return await chrome.tabs.create({ url: "https://x.com/home", active: true });
}

async function sendToXTab(message) {
  const tab = await getXTab();
  if (!tab?.id) throw new Error("No X tab available.");
  await chrome.tabs.sendMessage(tab.id, message);
  return tab.id;
}

async function proxyHttp(request = {}) {
  const url = String(request.url || "").trim();
  if (!url) {
    throw new Error("Missing request.url");
  }
  const method = String(request.method || "GET").toUpperCase();
  const headers = request.headers && typeof request.headers === "object" ? request.headers : {};
  const body = request.body == null ? undefined : request.body;
  const responseType = String(request.responseType || "json").toLowerCase();
  const response = await fetch(url, { method, headers, body });
  const responseHeaders = Object.fromEntries(response.headers.entries());
  if (responseType === "arraybuffer") {
    const arrayBuffer = await response.arrayBuffer();
    return {
      ok: true,
      httpOk: response.ok,
      status: response.status,
      headers: responseHeaders,
      contentType: String(response.headers.get("content-type") || ""),
      arrayBuffer
    };
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return {
    ok: true,
    httpOk: response.ok,
    status: response.status,
    headers: responseHeaders,
    json
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const type = String(message?.type || "");
    if (type === "XWEB_GET_CONFIG") {
      sendResponse({ ok: true, config: await getConfig() });
      return;
    }
    if (type === "XWEB_SAVE_CONFIG") {
      const config = await saveConfig(message.config || {});
      sendResponse({ ok: true, config });
      return;
    }
    if (type === "XWEB_START") {
      const config = await saveConfig(message.config || (await getConfig()));
      const tabId = await sendToXTab({ type: "XWEB_START", config });
      sendResponse({ ok: true, tabId, config });
      return;
    }
    if (type === "XWEB_STOP") {
      const tabId = await sendToXTab({ type: "XWEB_STOP" });
      sendResponse({ ok: true, tabId });
      return;
    }
    if (type === "XWEB_STATUS") {
      const tab = await getXTab();
      const response = await chrome.tabs.sendMessage(tab.id, { type: "XWEB_STATUS" }).catch(() => null);
      sendResponse({ ok: true, tabId: tab.id, status: response || { running: false, status: "disconnected" } });
      return;
    }
    if (type === "XWEB_HTTP") {
      const result = await proxyHttp(message.request || {});
      sendResponse(result);
      return;
    }
    sendResponse({ ok: false, error: "unknown_message_type" });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true;
});
