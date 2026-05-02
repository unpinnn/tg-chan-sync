"use strict";

function createPreparedUnit(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  return { messages: safeMessages };
}

function countPreparedUnitMessages(preparedUnits) {
  if (!Array.isArray(preparedUnits)) {
    return 0;
  }
  return preparedUnits.reduce((sum, unit) => {
    const messages = Array.isArray(unit?.messages) ? unit.messages : [];
    return sum + messages.length;
  }, 0);
}

module.exports = {
  countPreparedUnitMessages,
  createPreparedUnit
};
