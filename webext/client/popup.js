"use strict";

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const serverBaseUrlEl = $("serverBaseUrl");
const tokenEl = $("token");
const pollMsEl = $("pollMs");
const maxTextLengthEl = $("maxTextLength");
const postIntervalMsRangeEl = $("postIntervalMsRange");

function setStatus(text, isError = false) {
  statusEl.textContent = String(text || "");
  statusEl.style.color = isError ? "#ff9aa2" : "#9ad0ff";
}

function request(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "unknown error"));
        return;
      }
      resolve(response);
    });
  });
}

function readForm() {
  return {
    serverBaseUrl: String(serverBaseUrlEl.value || "").trim(),
    token: String(tokenEl.value || "").trim(),
    pollMs: Number.parseInt(String(pollMsEl.value || "1500"), 10),
    maxTextLength: Number.parseInt(String(maxTextLengthEl.value || "260"), 10),
    postIntervalMsRange: String(postIntervalMsRangeEl.value || "").trim()
  };
}

function fillForm(config) {
  serverBaseUrlEl.value = config.serverBaseUrl || "";
  tokenEl.value = config.token || "";
  pollMsEl.value = String(config.pollMs || 1500);
  maxTextLengthEl.value = String(config.maxTextLength || 260);
  postIntervalMsRangeEl.value = String(config.postIntervalMsRange || "1800-3200");
}

async function loadConfig() {
  const response = await request({ type: "XWEB_GET_CONFIG" });
  fillForm(response.config || {});
}

$("save").addEventListener("click", async () => {
  try {
    const response = await request({ type: "XWEB_SAVE_CONFIG", config: readForm() });
    fillForm(response.config || {});
    setStatus("Config saved.");
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, true);
  }
});

$("start").addEventListener("click", async () => {
  try {
    const response = await request({ type: "XWEB_START", config: readForm() });
    setStatus(`Started on tab ${response.tabId}.`);
  } catch (error) {
    setStatus(`Start failed: ${error.message}`, true);
  }
});

$("stop").addEventListener("click", async () => {
  try {
    const response = await request({ type: "XWEB_STOP" });
    setStatus(`Stopped (tab ${response.tabId}).`);
  } catch (error) {
    setStatus(`Stop failed: ${error.message}`, true);
  }
});

$("statusBtn").addEventListener("click", async () => {
  try {
    const response = await request({ type: "XWEB_STATUS" });
    const status = response.status || {};
    setStatus(`running=${!!status.running}\nstatus=${status.status || "unknown"}\ntab=${response.tabId}`);
  } catch (error) {
    setStatus(`Status failed: ${error.message}`, true);
  }
});

loadConfig().catch((error) => setStatus(`Init failed: ${error.message}`, true));
