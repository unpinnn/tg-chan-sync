function createPostRangeHelpers(deps = {}) {
  const START_FROM_ID = deps.START_FROM_ID;
  const END_AT_ID = deps.END_AT_ID;
  const START_FROM_COUNT = deps.START_FROM_COUNT;
  const END_AT_COUNT = deps.END_AT_COUNT;
  const START_FROM_DATE = deps.START_FROM_DATE;
  const START_FROM_DATE_MS = deps.START_FROM_DATE_MS;
  const END_AT_DATE = deps.END_AT_DATE;
  const END_AT_DATE_MS = deps.END_AT_DATE_MS;
  const activeScopeRef = deps.activeScopeRef;
  const normalizeDate = deps.normalizeDate;

  if (typeof normalizeDate !== "function") {
    throw new Error("createPostRangeHelpers: normalizeDate is required");
  }
  if (!activeScopeRef) {
    throw new Error("createPostRangeHelpers: activeScopeRef is required");
  }

  function inRange(messageId) {
    if (START_FROM_ID > 0 && messageId < START_FROM_ID) return false;
    if (END_AT_ID > 0 && messageId > END_AT_ID) return false;
    return true;
  }

  function inDateRange(messageDate) {
    if (activeScopeRef.startMs <= 0 && activeScopeRef.endMs <= 0) return true;
    const d = normalizeDate(messageDate);
    const ms = d.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return false;
    if (activeScopeRef.startMs > 0 && ms < activeScopeRef.startMs) return false;
    if (activeScopeRef.endMs > 0 && ms > activeScopeRef.endMs) return false;
    return true;
  }

  function inCountRange(count1Based) {
    if (START_FROM_COUNT > 0 && count1Based < START_FROM_COUNT) return false;
    if (END_AT_COUNT > 0 && count1Based > END_AT_COUNT) return false;
    return true;
  }

  function rangeLabel(start, end) {
    const startLabel = start > 0 ? String(start) : "start";
    const endLabel = end > 0 ? String(end) : "end";
    return `${startLabel}..${endLabel}`;
  }

  function dateRangeLabel(startDate, endDate) {
    const startLabel = startDate ? startDate.toISOString() : "start";
    const endLabel = endDate ? endDate.toISOString() : "end";
    return `${startLabel}..${endLabel}`;
  }

  function isSameLocalCalendarDay(aDate, bDate) {
    return (
      aDate.getFullYear() === bDate.getFullYear() &&
      aDate.getMonth() === bDate.getMonth() &&
      aDate.getDate() === bDate.getDate()
    );
  }

  function resolveEffectiveStartDateFromUnits(postUnits) {
    if (START_FROM_DATE_MS <= 0) {
      return {
        adjusted: false,
        effectiveStartDate: START_FROM_DATE,
        effectiveStartMs: START_FROM_DATE_MS
      };
    }

    const requestedDate = normalizeDate(START_FROM_DATE_MS);
    let hasRequestedDay = false;
    let nearestEarlierMs = 0;

    for (const unit of postUnits || []) {
      for (const message of unit || []) {
        const d = normalizeDate(message?.date);
        const ms = d.getTime();
        if (!Number.isFinite(ms) || ms <= 0) {
          continue;
        }
        if (isSameLocalCalendarDay(d, requestedDate)) {
          hasRequestedDay = true;
        }
        if (ms < START_FROM_DATE_MS && ms > nearestEarlierMs) {
          nearestEarlierMs = ms;
        }
      }
    }

    if (hasRequestedDay || nearestEarlierMs <= 0) {
      return {
        adjusted: false,
        effectiveStartDate: START_FROM_DATE,
        effectiveStartMs: START_FROM_DATE_MS
      };
    }

    return {
      adjusted: true,
      requestedStartDate: START_FROM_DATE,
      effectiveStartDate: new Date(nearestEarlierMs),
      effectiveStartMs: nearestEarlierMs
    };
  }

  function resolveEffectiveEndDateFromUnits(postUnits) {
    if (END_AT_DATE_MS <= 0) {
      return {
        adjusted: false,
        effectiveEndDate: END_AT_DATE,
        effectiveEndMs: END_AT_DATE_MS
      };
    }

    const requestedDate = normalizeDate(END_AT_DATE_MS);
    let hasRequestedDay = false;
    let nearestLaterMs = 0;

    for (const unit of postUnits || []) {
      for (const message of unit || []) {
        const d = normalizeDate(message?.date);
        const ms = d.getTime();
        if (!Number.isFinite(ms) || ms <= 0) {
          continue;
        }
        if (isSameLocalCalendarDay(d, requestedDate)) {
          hasRequestedDay = true;
        }
        if (ms > END_AT_DATE_MS && (nearestLaterMs <= 0 || ms < nearestLaterMs)) {
          nearestLaterMs = ms;
        }
      }
    }

    if (hasRequestedDay || nearestLaterMs <= 0) {
      return {
        adjusted: false,
        effectiveEndDate: END_AT_DATE,
        effectiveEndMs: END_AT_DATE_MS
      };
    }

    return {
      adjusted: true,
      requestedEndDate: END_AT_DATE,
      effectiveEndDate: new Date(nearestLaterMs),
      effectiveEndMs: nearestLaterMs
    };
  }

  function messageUnitMatchesSourceScope(messages) {
    if (START_FROM_ID <= 0 && END_AT_ID <= 0 && START_FROM_DATE_MS <= 0 && END_AT_DATE_MS <= 0) {
      return true;
    }
    return messages.some((m) => inRange(Number(m?.id || 0)) && inDateRange(m?.date));
  }

  function setActiveScopeRange(nextStartDate, nextStartMs, nextEndDate, nextEndMs) {
    activeScopeRef.startDate = nextStartDate || null;
    activeScopeRef.startMs = Number(nextStartMs || 0);
    activeScopeRef.endDate = nextEndDate || null;
    activeScopeRef.endMs = Number(nextEndMs || 0);
  }

  return {
    dateRangeLabel,
    inCountRange,
    messageUnitMatchesSourceScope,
    rangeLabel,
    resolveEffectiveEndDateFromUnits,
    resolveEffectiveStartDateFromUnits,
    setActiveScopeRange
  };
}

module.exports = {
  createPostRangeHelpers
};
