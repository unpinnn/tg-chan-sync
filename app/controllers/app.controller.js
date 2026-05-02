"use strict";

const path = require("path");
const { spawn } = require("child_process");
const { resolveCommandContext } = require("./command.controller");
const { CliError } = require("../models/cli-error.model");
const { start } = require("../services/sync.service");

async function runCommand(commandContext) {
  if (!commandContext || !commandContext.command) {
    throw new CliError("Missing command context.", {
      exitCode: 64,
      userMessage: "Missing command context."
    });
  }
  return start(commandContext);
}

function parseDestChannels(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const out = [];
  const seen = new Set();
  for (const part of text.split("||")) {
    const value = String(part || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function resolveLocal2DestTargets(commandContext) {
  if (!commandContext?.isLocal2Dest) return [];
  const fromDestsArg = parseDestChannels(commandContext.destChannelsOverride);
  if (fromDestsArg.length > 0) return fromDestsArg;
  const fromDestArg = String(commandContext.destChannelOverride || "").trim();
  if (fromDestArg) return [fromDestArg];
  const fromEnvDests = parseDestChannels(process.env.DEST_CHANNELS || "");
  if (fromEnvDests.length > 0) return fromEnvDests;
  const fromEnvDest = String(process.env.DEST_CHANNEL || "").trim();
  return fromEnvDest ? [fromEnvDest] : [];
}

function isDestChannelsAsyncEnabled() {
  return /^(1|true)$/i.test(String(process.env.DEST_CHANNELS_ASYNC || "0"));
}

function resolveDestChannelsMaxConcurrency() {
  const raw = String(process.env.DEST_CHANNELS_MAX_CONCURRENCY || "").trim();
  if (!raw) return 3;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 3;
  return Math.max(1, parsed);
}

function formatDestinationLabel(destination, index, total) {
  const raw = String(destination || "").trim();
  const fromUrl = raw.match(/^(?:https?:\/\/)?t\.me\/([^/?#]+)/i);
  const id = fromUrl ? fromUrl[1] : raw;
  const shortId = id.length > 32 ? `${id.slice(0, 29)}...` : id;
  return `dest ${index + 1}/${total} ${shortId}`;
}

function streamWithPrefix(stream, writer, prefix) {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk) => {
    const text = String(chunk ?? "").replace(/\r/g, "\n");
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      writer.write(`${prefix} ${line}\n`);
    }
  });
  stream.on("end", () => {
    const rest = buffer.trim();
    if (rest) {
      writer.write(`${prefix} ${rest}\n`);
    }
  });
}

function buildChildArgsForLocal2Dest(commandContext, destination) {
  const args = [path.resolve(__dirname, "..", "main.js"), "local2dest", "--dest", destination];
  const envFilePath = String(commandContext?.envFilePath || "").trim();
  const localArchiveDir = String(commandContext?.localArchiveDir || "").trim();
  if (envFilePath) {
    args.push("--env", envFilePath);
  }
  if (localArchiveDir) {
    args.push("--local", localArchiveDir);
  }
  return args;
}

function runLocal2DestChild(commandContext, destination, destinationLabel = "") {
  return new Promise((resolve, reject) => {
    const args = buildChildArgsForLocal2Dest(commandContext, destination);
    const childEnv = {
      ...process.env,
      DEST_CHANNEL: destination,
      DEST_CHANNELS: "",
      DEST_CHANNELS_ASYNC: "0"
    };
    const prefix = destinationLabel ? `[${destinationLabel}]` : "[dest]";
    const child = spawn(process.execPath, args, {
      stdio: ["inherit", "pipe", "pipe"],
      env: childEnv
    });
    streamWithPrefix(child.stdout, process.stdout, prefix);
    streamWithPrefix(child.stderr, process.stderr, prefix);
    child.on("error", (error) => {
      reject(
        new CliError(`local2dest child failed for ${destinationLabel || destination}: ${error?.message || error}`, {
          exitCode: 1
        })
      );
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new CliError(`local2dest failed for ${destinationLabel || destination} (exit=${code})`, {
          exitCode: Number.isInteger(code) ? code : 1
        })
      );
    });
  });
}

async function runLocal2DestForMany(commandContext, destinations) {
  const asyncMode = isDestChannelsAsyncEnabled();
  const maxConcurrency = Math.max(1, Math.min(destinations.length, resolveDestChannelsMaxConcurrency()));
  const modeLabel = asyncMode ? "async" : "sequential";
  console.log(
    `[multi-dest] local2dest targets=${destinations.length} mode=${modeLabel} max_concurrency=${asyncMode ? maxConcurrency : 1}`
  );
  if (!asyncMode) {
    for (let i = 0; i < destinations.length; i += 1) {
      const destination = destinations[i];
      const label = formatDestinationLabel(destination, i, destinations.length);
      console.log(`[multi-dest] starting ${label}`);
      await runLocal2DestChild(commandContext, destination, label);
    }
    return;
  }

  const failures = [];
  let cursor = 0;
  let active = 0;
  await new Promise((resolve) => {
    const launchNext = () => {
      while (active < maxConcurrency && cursor < destinations.length) {
        const index = cursor;
        const destination = destinations[index];
        const label = formatDestinationLabel(destination, index, destinations.length);
        cursor += 1;
        active += 1;
        console.log(`[multi-dest] starting ${label}`);
        runLocal2DestChild(commandContext, destination, label)
          .catch((error) => {
            failures.push(error);
          })
          .finally(() => {
            active -= 1;
            if (cursor >= destinations.length && active === 0) {
              resolve();
              return;
            }
            launchNext();
          });
      }
    };
    launchNext();
  });

  const failed = failures;
  if (failed.length > 0) {
    throw new CliError(
      `local2dest multi-destination run finished with failures (${failed.length}/${destinations.length}).`,
      { exitCode: 1 }
    );
  }
}

async function runApp(argv = process.argv) {
  const commandContext = resolveCommandContext(argv?.[2], argv?.slice?.(3) || []);
  if (commandContext?.envFilePath) {
    process.env.DOTENV_CONFIG_PATH = commandContext.envFilePath;
  }
  if (commandContext?.destChannelOverride) {
    process.env.DEST_CHANNEL = commandContext.destChannelOverride;
  }
  if (commandContext?.localArchiveDir) {
    process.env.LOCAL_ARCHIVE_DIR = commandContext.localArchiveDir;
  }
  const destinations = resolveLocal2DestTargets(commandContext);
  if (commandContext?.isLocal2Dest && destinations.length > 1) {
    await runLocal2DestForMany(commandContext, destinations);
    return;
  }
  if (commandContext?.isLocal2Dest && destinations.length === 1) {
    process.env.DEST_CHANNEL = destinations[0];
  }
  await runCommand(commandContext);
}

module.exports = {
  runApp,
  runCommand
};
