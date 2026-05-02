function createMediaProgressHelpers(deps = {}) {
  const SHOW_PROGRESS = deps.SHOW_PROGRESS;
  const PROGRESS_MIN_UPDATE_MS = deps.PROGRESS_MIN_UPDATE_MS;
  const formatBytes = deps.formatBytes;
  const formatDurationShort = deps.formatDurationShort;
  const renderProgressLine = deps.renderProgressLine;
  const clearProgressLine = deps.clearProgressLine;
  const getMessageMediaSizeBytes = deps.getMessageMediaSizeBytes;

  function numberFromProgressValue(value) {
    if (value == null) return 0;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === "bigint") {
      return Number(value);
    }
    if (typeof value === "string") {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    if (typeof value?.toJSNumber === "function") {
      const n = value.toJSNumber();
      return Number.isFinite(n) ? n : 0;
    }
    if (typeof value?.valueOf === "function") {
      const raw = value.valueOf();
      if (typeof raw === "number" && Number.isFinite(raw)) {
        return raw;
      }
    }
    if (typeof value?.toString === "function") {
      const n = Number(value.toString());
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function createDownloadProgressTracker(message) {
    if (!SHOW_PROGRESS) {
      return null;
    }
    const label = `#${message?.id ?? "?"}`;
    let startedAt = Date.now();
    let lastDrawAt = 0;
    let downloadedBytes = 0;
    let totalBytes = 0;

    const draw = (force = false) => {
      const now = Date.now();
      if (!force && now - lastDrawAt < PROGRESS_MIN_UPDATE_MS) {
        return;
      }
      lastDrawAt = now;
      const elapsedSec = Math.max((now - startedAt) / 1000, 0.001);
      const speed = downloadedBytes / elapsedSec;
      const hasTotal = totalBytes > 0;
      const percent = hasTotal ? Math.min((downloadedBytes / totalBytes) * 100, 100) : 0;
      const remaining = hasTotal ? Math.max(totalBytes - downloadedBytes, 0) : 0;
      const etaSec = speed > 0 ? remaining / speed : 0;
      const progressText = hasTotal ? `${percent.toFixed(1)}%` : "--.-%";
      const totalText = hasTotal ? formatBytes(totalBytes) : "?";
      const etaText = hasTotal && speed > 0 ? formatDurationShort(etaSec) : "--:--";
      renderProgressLine(
        `[DL] ${label} ${progressText} ${formatBytes(downloadedBytes)}/${totalText} ${formatBytes(speed)}/s ETA ${etaText}`
      );
    };

    return {
      callback: async (downloaded, total) => {
        const nextDownloaded = Math.max(0, numberFromProgressValue(downloaded));
        const nextTotal = Math.max(0, numberFromProgressValue(total));
        if (nextDownloaded < downloadedBytes) {
          startedAt = Date.now();
        }
        downloadedBytes = nextDownloaded;
        if (nextTotal > 0) {
          totalBytes = nextTotal;
        }
        draw(false);
      },
      done: () => {
        draw(true);
        clearProgressLine();
      }
    };
  }

  function createBatchDownloadProgressTracker(messages, workerCount) {
    if (!SHOW_PROGRESS) {
      return null;
    }
    const items = new Map();
    for (const message of messages) {
      if (!message?.media) continue;
      items.set(message.id, {
        downloaded: 0,
        total: Math.max(0, getMessageMediaSizeBytes(message)),
        done: false
      });
    }
    if (!items.size) {
      return null;
    }

    const totalFiles = items.size;
    let startedAt = Date.now();
    let lastDrawAt = 0;
    let activeCount = 0;
    let completedCount = 0;

    const draw = (force = false) => {
      const now = Date.now();
      if (!force && now - lastDrawAt < PROGRESS_MIN_UPDATE_MS) {
        return;
      }
      lastDrawAt = now;

      let downloadedBytes = 0;
      let knownTotalBytes = 0;
      for (const item of items.values()) {
        downloadedBytes += Math.max(0, Number(item.downloaded || 0));
        if (item.total > 0) {
          knownTotalBytes += item.total;
        }
      }

      const elapsedSec = Math.max((now - startedAt) / 1000, 0.001);
      const speed = downloadedBytes / elapsedSec;
      const percent = knownTotalBytes > 0 ? Math.min((downloadedBytes / knownTotalBytes) * 100, 100) : 0;
      const remainBytes = knownTotalBytes > 0 ? Math.max(knownTotalBytes - downloadedBytes, 0) : 0;
      const etaSec = speed > 0 ? remainBytes / speed : 0;

      const totalText = knownTotalBytes > 0 ? formatBytes(knownTotalBytes) : "?";
      const percentText = knownTotalBytes > 0 ? `${percent.toFixed(1)}%` : "--.-%";
      const etaText = knownTotalBytes > 0 && speed > 0 ? formatDurationShort(etaSec) : "--:--";
      const shownCompletedCount = totalFiles === 1 ? Math.max(completedCount, 1) : completedCount;
      renderProgressLine(
        `[DL] files ${shownCompletedCount}/${totalFiles} active ${activeCount}/${workerCount} ${percentText} ${formatBytes(downloadedBytes)}/${totalText} ${formatBytes(speed)}/s ETA ${etaText}`
      );
    };

    return {
      start: (_workerIndex, messageId) => {
        if (!items.has(messageId)) return;
        activeCount += 1;
        draw(true);
      },
      progressCallbackFor: (_workerIndex, messageId) => async (downloaded, total) => {
        const item = items.get(messageId);
        if (!item) return;
        const nextDownloaded = Math.max(0, numberFromProgressValue(downloaded));
        const nextTotal = Math.max(0, numberFromProgressValue(total));
        if (nextDownloaded < item.downloaded) {
          startedAt = Date.now();
        }
        item.downloaded = nextDownloaded;
        if (nextTotal > 0) {
          item.total = nextTotal;
        }
        draw(false);
      },
      finish: (_workerIndex, messageId) => {
        const item = items.get(messageId);
        if (!item) return;
        if (!item.done) {
          item.done = true;
          completedCount += 1;
        }
        activeCount = Math.max(0, activeCount - 1);
        draw(true);
        if (completedCount >= totalFiles) {
          clearProgressLine();
        }
      },
      done: () => {
        clearProgressLine();
      }
    };
  }

  return {
    createBatchDownloadProgressTracker,
    createDownloadProgressTracker
  };
}

module.exports = {
  createMediaProgressHelpers
};
