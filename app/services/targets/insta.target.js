"use strict";

function createInstaTargetAdapter() {
  function assertPostMode(postMode) {
    const mode = String(postMode || "").toLowerCase();
    if (!["own-post", "forwarded"].includes(mode)) {
      throw new Error(`Unsupported POST_MODE "${postMode}" for instagram target.`);
    }
  }

  async function postMessages() {
    throw new Error("Target adapter instagram is not implemented yet.");
  }

  return {
    key: "insta",
    label: "instagram",
    assertPostMode,
    postMessages
  };
}

module.exports = {
  createInstaTargetAdapter
};
