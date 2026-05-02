"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveCommandContext } = require("../app/controllers/command.controller");
const { CliError } = require("../app/models/cli-error.model");

test("resolveCommandContext: src2local", () => {
  const ctx = resolveCommandContext("src2local");
  assert.equal(ctx.command, "src2local");
  assert.equal(ctx.isSrc2Local, true);
  assert.equal(ctx.isLocal2Dest, false);
  assert.equal(ctx.infoTag, "[DL-INFO]");
  assert.equal(ctx.localArchiveDir, "");
});

test("resolveCommandContext: local2dest", () => {
  const ctx = resolveCommandContext("local2dest");
  assert.equal(ctx.command, "local2dest");
  assert.equal(ctx.isSrc2Local, false);
  assert.equal(ctx.isLocal2Dest, true);
  assert.equal(ctx.infoTag, "[UL-INFO]");
  assert.equal(ctx.local2Profile?.key, "dest");
  assert.equal(ctx.localArchiveDir, "");
});

test("resolveCommandContext: src2local with --local", () => {
  const ctx = resolveCommandContext("src2local", ["--local", "myfolder/channel-archive1"]);
  assert.equal(ctx.command, "src2local");
  assert.equal(ctx.localArchiveDir, "myfolder/channel-archive1");
});

test("resolveCommandContext: src2local with --env", () => {
  const ctx = resolveCommandContext("src2local", ["--env", ".env.alt"]);
  assert.equal(ctx.command, "src2local");
  assert.equal(ctx.envFilePath, ".env.alt");
});

test("resolveCommandContext: local2dest with --dest", () => {
  const ctx = resolveCommandContext("local2dest", ["--dest", "https://t.me/my_dest_channel"]);
  assert.equal(ctx.command, "local2dest");
  assert.equal(ctx.destChannelOverride, "https://t.me/my_dest_channel");
});

test("resolveCommandContext: local2dest with --dests", () => {
  const ctx = resolveCommandContext("local2dest", [
    "--dests",
    "https://t.me/chan1||https://t.me/chan2"
  ]);
  assert.equal(ctx.command, "local2dest");
  assert.equal(ctx.destChannelsOverride, "https://t.me/chan1||https://t.me/chan2");
});

test("resolveCommandContext: local2dest with --local=...", () => {
  const ctx = resolveCommandContext("local2dest", ["--local=myfolder/channel-archive1"]);
  assert.equal(ctx.command, "local2dest");
  assert.equal(ctx.localArchiveDir, "myfolder/channel-archive1");
});

test("resolveCommandContext: --local missing value returns CliError exitCode=64", () => {
  assert.throws(
    () => resolveCommandContext("src2local", ["--local"]),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 64);
      assert.match(error.userMessage, /Missing value for --local/i);
      return true;
    }
  );
});

test("resolveCommandContext: --env missing value returns CliError exitCode=64", () => {
  assert.throws(
    () => resolveCommandContext("src2local", ["--env"]),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 64);
      assert.match(error.userMessage, /Missing value for --env/i);
      return true;
    }
  );
});

test("resolveCommandContext: --dest missing value returns CliError exitCode=64", () => {
  assert.throws(
    () => resolveCommandContext("local2dest", ["--dest"]),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 64);
      assert.match(error.userMessage, /Missing value for --dest/i);
      return true;
    }
  );
});

test("resolveCommandContext: --dests missing value returns CliError exitCode=64", () => {
  assert.throws(
    () => resolveCommandContext("local2dest", ["--dests"]),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 64);
      assert.match(error.userMessage, /Missing value for --dests/i);
      return true;
    }
  );
});

test("resolveCommandContext: help returns CliError exitCode=0", () => {
  assert.throws(
    () => resolveCommandContext("--help"),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 0);
      assert.match(error.userMessage, /Usage:\s+node app\/main\.js/i);
      return true;
    }
  );
});

test("resolveCommandContext: local2x", () => {
  const ctx = resolveCommandContext("local2x");
  assert.equal(ctx.command, "local2x");
  assert.equal(ctx.isSrc2Local, false);
  assert.equal(ctx.isLocal2Dest, false);
  assert.equal(ctx.infoTag, "[UL-INFO]");
  assert.equal(ctx.local2Profile?.key, "x");
});

test("resolveCommandContext: local2x-web", () => {
  const ctx = resolveCommandContext("local2x-web");
  assert.equal(ctx.command, "local2x-web");
  assert.equal(ctx.isSrc2Local, false);
  assert.equal(ctx.isLocal2Dest, false);
  assert.equal(ctx.infoTag, "[UL-INFO]");
  assert.equal(ctx.local2Profile?.key, "x-web");
});

test("resolveCommandContext: local2blogger", () => {
  const ctx = resolveCommandContext("local2blogger");
  assert.equal(ctx.command, "local2blogger");
  assert.equal(ctx.isSrc2Local, false);
  assert.equal(ctx.isLocal2Dest, false);
  assert.equal(ctx.infoTag, "[UL-INFO]");
  assert.equal(ctx.local2Profile?.key, "blogger");
});

test("resolveCommandContext: local2wp.com", () => {
  const ctx = resolveCommandContext("local2wp.com");
  assert.equal(ctx.command, "local2wp.com");
  assert.equal(ctx.isSrc2Local, false);
  assert.equal(ctx.isLocal2Dest, false);
  assert.equal(ctx.infoTag, "[UL-INFO]");
  assert.equal(ctx.local2Profile?.key, "wp-com");
});

test("resolveCommandContext: local2bsky", () => {
  const ctx = resolveCommandContext("local2bsky");
  assert.equal(ctx.command, "local2bsky");
  assert.equal(ctx.isSrc2Local, false);
  assert.equal(ctx.isLocal2Dest, false);
  assert.equal(ctx.infoTag, "[UL-INFO]");
  assert.equal(ctx.local2Profile?.key, "bsky");
});

test("resolveCommandContext: unknown command returns CliError exitCode=64", () => {
  assert.throws(
    () => resolveCommandContext("nope"),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 64);
      assert.match(error.userMessage, /Unknown command "nope"/);
      return true;
    }
  );
});
