"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { assertValidTargetAdapter } = require("../app/services/targets/target.interface");
const { resolveTargetAdapter } = require("../app/services/targets/target-resolver.service");
const { createTelegramTargetAdapter } = require("../app/services/targets/telegram.target");
const { createXWebTargetAdapter } = require("../app/services/targets/x-web.target");
const { createWpComTargetAdapter } = require("../app/services/targets/wpcom.target");
const { createBskyTargetAdapter } = require("../app/services/targets/bsky.target");

test("assertValidTargetAdapter: accepts valid adapter", () => {
  const adapter = {
    key: "dest",
    assertPostMode() {},
    async postMessages() {
      return { sentCount: 0, mappingChanged: 0, sentSourceIds: [] };
    }
  };
  assert.doesNotThrow(() => assertValidTargetAdapter(adapter));
});

test("assertValidTargetAdapter: rejects missing methods", () => {
  assert.throws(() => assertValidTargetAdapter({ key: "dest" }), /assertPostMode/);
  assert.throws(() => assertValidTargetAdapter({ key: "dest", assertPostMode() {} }), /postMessages/);
});

test("resolveTargetAdapter: resolves by target key (case-insensitive)", () => {
  const adapter = resolveTargetAdapter({
    targetKey: "DEST",
    adaptersByKey: {
      dest: () => ({ key: "dest", assertPostMode() {}, postMessages: async () => ({}) })
    }
  });
  assert.equal(adapter.key, "dest");
});

test("resolveTargetAdapter: throws on unknown key", () => {
  assert.throws(
    () => resolveTargetAdapter({ targetKey: "unknown", adaptersByKey: { dest: () => ({}) } }),
    /No target adapter/
  );
});

test("telegram adapter: forwarded single message path", async () => {
  const calls = [];
  const adapter = createTelegramTargetAdapter({
    isGroupedPost: () => false,
    withHeartbeatLog: async (_label, action) => action(),
    logInfo: () => {},
    forwardMessage: async () => {
      calls.push("forwardMessage");
      return true;
    },
    forwardMessageGroup: async () => {
      throw new Error("should not be called");
    },
    reuploadGroupedMedia: async () => {
      throw new Error("should not be called");
    },
    reuploadMessageMedia: async () => {
      throw new Error("should not be called");
    },
    sendTextMessage: async () => {
      throw new Error("should not be called");
    },
    rememberMessageIdMappings: () => 0
  });

  adapter.assertPostMode("forwarded");
  const result = await adapter.postMessages({
    postMode: "forwarded",
    messages: [{ id: 101, message: "a", media: null }],
    cleanedTextById: new Map([[101, "a"]]),
    linkRewriteState: { sourceToDestinationId: new Map() }
  });

  assert.deepEqual(calls, ["forwardMessage"]);
  assert.equal(result.sentCount, 1);
  assert.equal(result.mappingChanged, 0);
  assert.deepEqual(result.sentSourceIds, [101]);
});

test("telegram adapter: own-post text message path", async () => {
  const adapter = createTelegramTargetAdapter({
    isGroupedPost: () => false,
    withHeartbeatLog: async (_label, action) => action(),
    logInfo: () => {},
    forwardMessage: async () => false,
    forwardMessageGroup: async () => false,
    reuploadGroupedMedia: async () => [],
    reuploadMessageMedia: async () => null,
    sendTextMessage: async () => ({ id: 201 }),
    rememberMessageIdMappings: (src, dst, state) => {
      const srcId = Number(src[0]?.id || 0);
      const dstId = Number(dst[0]?.id || 0);
      state.sourceToDestinationId.set(srcId, dstId);
      return 1;
    }
  });

  adapter.assertPostMode("own-post");
  const linkRewriteState = { sourceToDestinationId: new Map() };
  const result = await adapter.postMessages({
    postMode: "own-post",
    messages: [{ id: 11, message: "hello", media: null, entities: undefined }],
    cleanedTextById: new Map([[11, "hello"]]),
    linkRewriteState
  });

  assert.equal(result.sentCount, 1);
  assert.equal(result.mappingChanged, 1);
  assert.deepEqual(result.sentSourceIds, [11]);
  assert.equal(linkRewriteState.sourceToDestinationId.get(11), 201);
});

test("x-web adapter: posts thread", async () => {
  const calls = [];
  const adapter = createXWebTargetAdapter({
    getXWebClient: async () => ({
      sendPost: async ({ text, mediaPath, replyToId }) => {
        calls.push({ text, mediaPath, replyToId });
        return `${1000 + calls.length}`;
      }
    }),
    withHeartbeatLog: async (_label, action) => action(),
    logInfo: () => {}
  });

  adapter.assertPostMode("own-post");
  const result = await adapter.postMessages({
    messages: [{ id: 1, message: "hello world", media: true }],
    cleanedTextById: new Map([[1, "hello world"]]),
    downloadedMediaById: new Map([[1, "d:\\media\\a.jpg"]])
  });

  assert.equal(result.sentCount, 1);
  assert.deepEqual(result.sentSourceIds, [1]);
  assert.equal(calls[0].mediaPath, "d:\\media\\a.jpg");
});

test("x-web adapter: grouped media messages are batched", async () => {
  const calls = [];
  const adapter = createXWebTargetAdapter({
    getXWebClient: async () => ({
      sendPost: async ({ text, mediaPaths }) => {
        calls.push({ text, mediaPaths });
        return `${2000 + calls.length}`;
      }
    }),
    withHeartbeatLog: async (_label, action) => action(),
    logInfo: () => {}
  });

  const result = await adapter.postMessages({
    messages: [
      { id: 10, media: true, message: "first" },
      { id: 11, media: true, message: "" }
    ],
    cleanedTextById: new Map([
      [10, "caption"],
      [11, ""]
    ]),
    downloadedMediaById: new Map([
      [10, "d:\\media\\10.jpg"],
      [11, "d:\\media\\11.jpg"]
    ])
  });

  assert.equal(result.sentCount, 2);
  assert.deepEqual(result.sentSourceIds, [10, 11]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].mediaPaths, ["d:\\media\\10.jpg", "d:\\media\\11.jpg"]);
});

test("wp-com adapter: preflight is skipped in dry run", async () => {
  const adapter = createWpComTargetAdapter({
    getWpComClient: () => ({
      getSite: async () => ({ id: "100", url: "https://example.wordpress.com" }),
      createPost: async () => ({ ID: "1" }),
      deletePost: async () => ({})
    }),
    withHeartbeatLog: async (_label, action) => action(),
    sleepWithAdaptivePacing: async () => {},
    logInfo: () => {},
    getPostArchiveRow: () => null,
    mainSiteId: "100",
    mediaSiteIds: [],
    mediaStrategy: "round-robin",
    mediaFailover: true,
    wpTags: [],
    wpReset: false,
    wpRetryMax: 1,
    wpRetryWaitRange: { min: 1, max: 1 }
  });

  adapter.assertPostMode("own-post");
  await adapter.preflightBeforeRun({ DRY_RUN: true });
});

test("bsky adapter: preflight is skipped in dry run", async () => {
  let sessionChecked = false;
  const adapter = createBskyTargetAdapter({
    getBskyClient: () => ({
      getSession: async () => {
        sessionChecked = true;
        return { did: "did:plc:123", handle: "example.bsky.social" };
      }
    }),
    withHeartbeatLog: async (_label, action) => action(),
    sleepWithAdaptivePacing: async () => {},
    logInfo: () => {},
    getPostArchiveRow: () => null,
    bskyReset: false,
    bskyEnableVideo: false,
    bskyTags: [],
    bskyTextMax: 300,
    bskyImagesMax: 4,
    bskyImageMaxBytes: 1000000,
    bskyRetryMax: 1,
    bskyRetryWaitRange: { min: 1, max: 1 },
    bskyPollRange: { min: 1, max: 1 }
  });

  adapter.assertPostMode("own-post");
  await adapter.preflightBeforeRun({ DRY_RUN: true });
  assert.equal(sessionChecked, false);
});
