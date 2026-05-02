const { buildTaggedLine } = require("../../views/log.view");

function createRuntimePacing(deps = {}) {
  const showProgress = !!deps.showProgress;
  const heartbeatLogMs = Number(deps.heartbeatLogMs || 8000);
  const dryRun = !!deps.dryRun;
  const waitRangeDefault = deps.waitRangeDefault || { min: 0, max: 0 };
  const waitRangePost = deps.waitRangePost || waitRangeDefault;
  const waitRangeBlogger = deps.waitRangeBlogger || waitRangePost;
  const waitRangeWpCom = deps.waitRangeWpCom || waitRangePost;
  const waitRangeBsky = deps.waitRangeBsky || waitRangePost;
  const floodBackoffGain = Number(deps.floodBackoffGain || 0);
  const floodBackoffMaxMs = Number(deps.floodBackoffMaxMs || 0);
  const floodBackoffDecayMs = Number(deps.floodBackoffDecayMs || 0);
  const formatDurationShort = deps.formatDurationShort;
  const formatDurationVerbose = deps.formatDurationVerbose;
  const getMetaValue = deps.getMetaValue;
  const setMetaValue = deps.setMetaValue;

  let infoTag = String(deps.infoTag || "[INFO]");
  let activeProgressLineLength = 0;
  let floodWaitUntilMs = 0;
  let floodWaitDescription = "";
  let floodWaitStage = "generic";
  let adaptiveWaitExtraPostMs = 0;
  let adaptiveWaitExtraBloggerMs = 0;
  let adaptiveWaitExtraWpComMs = 0;
  let adaptiveWaitExtraBskyMs = 0;
  let activeArchiveDb = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setInfoTag(nextTag) {
    infoTag = String(nextTag || "[INFO]");
  }

  function setActiveArchiveDb(db) {
    activeArchiveDb = db || null;
  }

  function logInfo(message) {
    console.log(buildTaggedLine(infoTag, message));
  }

  function renderProgressLine(text) {
    if (!showProgress || !process.stdout?.write) return;
    const columns = Number(process.stdout.columns || 0);
    let line = String(text || "");
    if (columns > 1 && line.length > columns - 1) {
      line = line.slice(0, columns - 1);
    }
    if (line.length < activeProgressLineLength) {
      line = line.padEnd(activeProgressLineLength, " ");
    }
    process.stdout.write(`\r${line}`);
    activeProgressLineLength = line.length;
  }

  function clearProgressLine() {
    if (!showProgress || !process.stdout?.write || activeProgressLineLength <= 0) return;
    process.stdout.write(`\r${" ".repeat(activeProgressLineLength)}\r`);
    activeProgressLineLength = 0;
  }

  function parseFloodWaitSeconds(error) {
    const direct = Number(error?.seconds || error?.value || 0);
    if (Number.isFinite(direct) && direct > 0) return Math.ceil(direct);
    const text = String(error?.errorMessage || error?.message || "");
    const m = text.match(/FLOOD_WAIT_(\d+)/);
    if (m) return Number.parseInt(m[1], 10);
    return 0;
  }

  function formatFloodWaitHuman(seconds) {
    const safe = Math.max(0, Math.floor(Number(seconds || 0)));
    if (safe < 60) return `${safe}s`;
    const mins = Math.floor(safe / 60);
    const rem = safe % 60;
    return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
  }

  function inferFloodStage(description) {
    const text = String(description || "").toLowerCase();
    if (text.includes("wpcom") || text.includes("wordpress")) {
      return "wpcom";
    }
    if (text.includes("bsky") || text.includes("bluesky")) {
      return "bsky";
    }
    if (
      text.includes("upload") ||
      text.includes("send text") ||
      text.includes("send overflow") ||
      text.includes("forward")
    ) {
      return "post";
    }
    return "generic";
  }

  function stageWaitExtraMs(stage) {
    if (stage === "post") return adaptiveWaitExtraPostMs;
    if (stage === "blogger") return adaptiveWaitExtraBloggerMs;
    if (stage === "wpcom") return adaptiveWaitExtraWpComMs;
    if (stage === "bsky") return adaptiveWaitExtraBskyMs;
    return 0;
  }

  function increaseAdaptiveBackoff(stage, floodWaitSeconds) {
    const base = Math.max(0, Number(floodWaitSeconds || 0) * 1000);
    if (base <= 0) return;
    const increment = Math.min(floodBackoffMaxMs, Math.max(0, Math.floor(base * floodBackoffGain)));
    if (stage === "post") {
      adaptiveWaitExtraPostMs = Math.min(floodBackoffMaxMs, adaptiveWaitExtraPostMs + increment);
      return;
    }
    if (stage === "blogger") {
      adaptiveWaitExtraBloggerMs = Math.min(floodBackoffMaxMs, adaptiveWaitExtraBloggerMs + increment);
      return;
    }
    if (stage === "wpcom") {
      adaptiveWaitExtraWpComMs = Math.min(floodBackoffMaxMs, adaptiveWaitExtraWpComMs + increment);
      return;
    }
    if (stage === "bsky") {
      adaptiveWaitExtraBskyMs = Math.min(floodBackoffMaxMs, adaptiveWaitExtraBskyMs + increment);
    }
  }

  function decayAdaptiveBackoff(stage) {
    if (stage === "post") {
      adaptiveWaitExtraPostMs = Math.max(0, adaptiveWaitExtraPostMs - floodBackoffDecayMs);
      return;
    }
    if (stage === "blogger") {
      adaptiveWaitExtraBloggerMs = Math.max(0, adaptiveWaitExtraBloggerMs - floodBackoffDecayMs);
      return;
    }
    if (stage === "wpcom") {
      adaptiveWaitExtraWpComMs = Math.max(0, adaptiveWaitExtraWpComMs - floodBackoffDecayMs);
      return;
    }
    if (stage === "bsky") {
      adaptiveWaitExtraBskyMs = Math.max(0, adaptiveWaitExtraBskyMs - floodBackoffDecayMs);
    }
  }

  function waitRangeForStage(stage) {
    if (stage === "blogger") return waitRangeBlogger;
    if (stage === "wpcom") return waitRangeWpCom;
    if (stage === "bsky") return waitRangeBsky;
    if (stage === "post") return waitRangePost;
    return waitRangeDefault;
  }

  function randomIntInclusive(minValue, maxValue) {
    const min = Math.max(0, Math.floor(Number(minValue || 0)));
    const max = Math.max(min, Math.floor(Number(maxValue || 0)));
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function msRangeLabel(range) {
    if (!range) return "0";
    if (range.min === range.max) return `${range.min}`;
    return `${range.min}-${range.max}`;
  }

  async function sleepWithAdaptivePacing(stage, reason = "") {
    const baseRange = waitRangeForStage(stage);
    const baseWaitMs = randomIntInclusive(baseRange.min, baseRange.max);
    const extraWaitMs = stageWaitExtraMs(stage);
    const totalWaitMs = baseWaitMs + extraWaitMs;
    if (totalWaitMs <= 0) return;
    if (reason && extraWaitMs > 0) {
      console.log(
        `[pace] ${reason}: waiting ${totalWaitMs}ms (base=${baseWaitMs}ms adaptive=${extraWaitMs}ms)`
      );
    }
    await sleep(totalWaitMs);
    decayAdaptiveBackoff(stage);
  }

  function persistedFloodCooldownMetaKey() {
    return "persisted_flood_cooldown";
  }

  function persistFloodCooldown(waitUntilMs, description, stage) {
    if (dryRun || !activeArchiveDb) return;
    const until = Math.max(0, Number(waitUntilMs || 0));
    if (!until) {
      setMetaValue(activeArchiveDb, persistedFloodCooldownMetaKey(), "");
      return;
    }
    const payload = {
      untilMs: until,
      untilIso: new Date(until).toISOString(),
      description: String(description || ""),
      stage: String(stage || "generic")
    };
    setMetaValue(activeArchiveDb, persistedFloodCooldownMetaKey(), JSON.stringify(payload));
  }

  function loadPersistedFloodCooldown(db) {
    const raw = String(getMetaValue(db, persistedFloodCooldownMetaKey()) || "").trim();
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw);
      const untilMs = Number(payload?.untilMs || 0);
      if (!Number.isFinite(untilMs) || untilMs <= 0) return null;
      return { untilMs, stage: String(payload?.stage || "generic") };
    } catch {
      return null;
    }
  }

  async function applyPersistedCooldownBeforeRun(db) {
    const persisted = loadPersistedFloodCooldown(db);
    if (!persisted) return;
    const remainingMs = persisted.untilMs - Date.now();
    if (remainingMs <= 0) return;
    clearProgressLine();
    console.log(
      `[cooldown] persisted flood cooldown active (stage=${persisted.stage}) -> waiting ${formatDurationVerbose(
        remainingMs / 1000
      )} before requests`
    );
    await sleep(remainingMs);
  }

  async function withHeartbeatLog(label, action, intervalMs = heartbeatLogMs, options = {}) {
    const startedAt = Date.now();
    let timer = null;
    const logElapsed = options.logElapsed !== false;
    const includeFlood = options.includeFlood !== false;
    const tick = () => {
      const elapsed = formatDurationShort((Date.now() - startedAt) / 1000);
      let suffix = logElapsed ? `elapsed ${elapsed}` : "";
      if (includeFlood && floodWaitUntilMs > Date.now()) {
        const remaining = Math.ceil((floodWaitUntilMs - Date.now()) / 1000);
        const floodText = `flood-wait(${floodWaitStage}) ${floodWaitDescription} ${formatDurationShort(
          remaining
        )} remaining`;
        suffix = suffix ? `${floodText}, ${suffix}` : floodText;
      }
      logInfo(`${label} ... ${suffix}`.trim());
    };
    if (intervalMs > 0) timer = setInterval(tick, intervalMs);
    try {
      return await action();
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  async function withFloodWaitRetry(action, description) {
    for (;;) {
      try {
        return await action();
      } catch (error) {
        const waitSeconds = parseFloodWaitSeconds(error);
        if (waitSeconds <= 0) throw error;
        const stage = inferFloodStage(description);
        const waitUntilMs = Date.now() + waitSeconds * 1000;
        floodWaitUntilMs = waitUntilMs;
        floodWaitDescription = String(description || "");
        floodWaitStage = stage;
        persistFloodCooldown(waitUntilMs, description, stage);
        increaseAdaptiveBackoff(stage, waitSeconds);
        clearProgressLine();
        console.warn(
          `[flood-wait] ${description} -> waiting ${formatFloodWaitHuman(waitSeconds)} (until ${new Date(
            waitUntilMs
          ).toISOString()}, stage=${stage})`
        );
        await sleep(waitSeconds * 1000);
        floodWaitUntilMs = 0;
        floodWaitDescription = "";
        floodWaitStage = "generic";
        persistFloodCooldown(0, "", "generic");
      }
    }
  }

  return {
    applyPersistedCooldownBeforeRun,
    clearProgressLine,
    logInfo,
    msRangeLabel,
    renderProgressLine,
    setActiveArchiveDb,
    setInfoTag,
    sleepWithAdaptivePacing,
    withFloodWaitRetry,
    withHeartbeatLog
  };
}

module.exports = {
  createRuntimePacing
};
