function parsePositiveIntEnv(rawValue, fallback, envName) {
  const text = String(rawValue ?? "").trim();
  if (!text) return fallback;
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`${envName} must be a non-negative integer.`);
    process.exit(1);
  }
  return n;
}

function parseFiniteNumber(rawValue, fallback, envName) {
  const text = String(rawValue ?? "").trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n)) {
    console.error(`${envName} must be a finite number.`);
    process.exit(1);
  }
  return n;
}

function parseMsRange(rawValue, envName, fallbackRange, requireRange = false) {
  const text = String(rawValue || "").trim();
  if (!text) return fallbackRange;
  const rangeMatch = text.match(/^(\d+)\s*[-:.,]{1,2}\s*(\d+)$/);
  const singleMatch = text.match(/^(\d+)$/);
  let minMs = 0;
  let maxMs = 0;
  if (rangeMatch) {
    minMs = Number.parseInt(rangeMatch[1], 10);
    maxMs = Number.parseInt(rangeMatch[2], 10);
  } else if (singleMatch && !requireRange) {
    minMs = Number.parseInt(singleMatch[1], 10);
    maxMs = minMs;
  } else {
    console.error(
      requireRange
        ? `${envName} must be "<min>-<max>" milliseconds.`
        : `${envName} must be "<min>-<max>" milliseconds or a single integer.`
    );
    process.exit(1);
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs < 0 || maxMs < 0) {
    console.error(`${envName} must contain non-negative integers.`);
    process.exit(1);
  }
  if (minMs > maxMs) {
    const tmp = minMs;
    minMs = maxMs;
    maxMs = tmp;
  }
  return { min: minMs, max: maxMs };
}

function parseEnvDateBoundary(rawValue, isEndBound, envName) {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let candidate = null;
  if (dateOnly) {
    const [_, y, m, d] = dateOnly;
    if (isEndBound) {
      candidate = new Date(Number(y), Number(m) - 1, Number(d), 23, 59, 59, 999);
    } else {
      candidate = new Date(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0);
    }
  } else {
    candidate = new Date(raw);
    if (Number.isNaN(candidate.getTime())) {
      console.error(`${envName} must be YYYY-MM-DD or a valid date/time string.`);
      process.exit(1);
    }
  }
  if (Number.isNaN(candidate.getTime())) {
    console.error(`${envName} is invalid.`);
    process.exit(1);
  }
  return candidate;
}

module.exports = {
  parseEnvDateBoundary,
  parseFiniteNumber,
  parseMsRange,
  parsePositiveIntEnv
};

