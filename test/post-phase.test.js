"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { runPostingPass } = require("../app/services/sync/post.phase");

test("runPostingPass: uses target adapter and updates posting state", async () => {
  const processedSourceIds = new Set();
  const linkRewriteState = { sourceToDestinationId: new Map() };
  let updatedPostCalls = 0;
  let markedPostedCalls = 0;
  let persistedCalls = 0;

  const result = await runPostingPass({
    archiveDb: {},
    cleanAndRewriteText: (x) => x,
    client: {},
    destination: {},
    DRY_RUN: false,
    formatRunDuration: () => "less than a second",
    getArchivedMediaPathMapForMessages: () => new Map(),
    isGroupedPost: () => false,
    IS_SRC2LOCAL: false,
    linkRewriteState,
    logInfo: () => {},
    logProcessingInfo: () => {},
    markCloneMessagesPostedInDb: () => {
      markedPostedCalls += 1;
    },
    pairKey: "1->2",
    POST_MODE: "own-post",
    preparedUnits: [{ messages: [{ id: 7, message: "text", media: null, entities: undefined }] }],
    processedSourceIds,
    sleepWithAdaptivePacing: async () => {},
    source: {},
    targetAdapter: {
      key: "dest",
      assertPostMode: () => {},
      postMessages: async () => ({
        sentCount: 1,
        mappingChanged: 1,
        sentSourceIds: [7]
      })
    },
    updatePostedPostInDb: () => {
      updatedPostCalls += 1;
    },
    persistArchiveState: () => {
      persistedCalls += 1;
    }
  });

  assert.equal(result.copied, 1);
  assert.equal(result.skipped, 0);
  assert.equal(processedSourceIds.has(7), true);
  assert.equal(updatedPostCalls, 1);
  assert.equal(markedPostedCalls, 1);
  assert.equal(persistedCalls, 1);
});
