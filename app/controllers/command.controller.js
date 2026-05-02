"use strict";

const {
  getLocal2Profile,
  isLocal2Command,
  listLocal2Profiles
} = require("../models/local2-target.model");
const {
  createLocal2Context,
  createSrc2LocalContext,
  normalizeCommand
} = require("../models/command-context.model");
const { CliError } = require("../models/cli-error.model");
const { buildUnknownCommandText, buildUsageText } = require("../views/usage.view");

function usageText() {
  return buildUsageText(listLocal2Profiles());
}

function isHelpCommand(command) {
  return command === "help" || command === "--help" || command === "-h";
}

function parseCliOptions(rawArgs = []) {
  const options = {
    localArchiveDir: "",
    envFilePath: "",
    destChannelOverride: "",
    destChannelsOverride: ""
  };

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i] || "").trim();
    if (!arg) continue;

    if (arg === "--local") {
      const next = String(rawArgs[i + 1] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new CliError("Missing value for --local", {
          exitCode: 64,
          userMessage: "Missing value for --local. Example: --local myfolder/channel-archive1"
        });
      }
      options.localArchiveDir = next;
      i += 1;
      continue;
    }

    if (arg.startsWith("--local=")) {
      const inline = String(arg.slice("--local=".length) || "").trim();
      if (!inline) {
        throw new CliError("Missing value for --local=", {
          exitCode: 64,
          userMessage: "Missing value for --local=. Example: --local=myfolder/channel-archive1"
        });
      }
      options.localArchiveDir = inline;
      continue;
    }

    if (arg === "--env") {
      const next = String(rawArgs[i + 1] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new CliError("Missing value for --env", {
          exitCode: 64,
          userMessage: "Missing value for --env. Example: --env .env.alt"
        });
      }
      options.envFilePath = next;
      i += 1;
      continue;
    }

    if (arg.startsWith("--env=")) {
      const inline = String(arg.slice("--env=".length) || "").trim();
      if (!inline) {
        throw new CliError("Missing value for --env=", {
          exitCode: 64,
          userMessage: "Missing value for --env=. Example: --env=.env.alt"
        });
      }
      options.envFilePath = inline;
      continue;
    }

    if (arg === "--dest") {
      const next = String(rawArgs[i + 1] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new CliError("Missing value for --dest", {
          exitCode: 64,
          userMessage: "Missing value for --dest. Example: --dest https://t.me/your_channel"
        });
      }
      options.destChannelOverride = next;
      i += 1;
      continue;
    }

    if (arg.startsWith("--dest=")) {
      const inline = String(arg.slice("--dest=".length) || "").trim();
      if (!inline) {
        throw new CliError("Missing value for --dest=", {
          exitCode: 64,
          userMessage: "Missing value for --dest=. Example: --dest=https://t.me/your_channel"
        });
      }
      options.destChannelOverride = inline;
      continue;
    }

    if (arg === "--dests") {
      const next = String(rawArgs[i + 1] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new CliError("Missing value for --dests", {
          exitCode: 64,
          userMessage:
            "Missing value for --dests. Example: --dests \"https://t.me/chan1||https://t.me/chan2\""
        });
      }
      options.destChannelsOverride = next;
      i += 1;
      continue;
    }

    if (arg.startsWith("--dests=")) {
      const inline = String(arg.slice("--dests=".length) || "").trim();
      if (!inline) {
        throw new CliError("Missing value for --dests=", {
          exitCode: 64,
          userMessage:
            "Missing value for --dests=. Example: --dests=https://t.me/chan1||https://t.me/chan2"
        });
      }
      options.destChannelsOverride = inline;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new CliError(`Unknown option "${arg}"`, {
        exitCode: 64,
        userMessage:
          `Unknown option "${arg}". Supported options: --local <path>, --env <file>, ` +
          `--dest <channel>, --dests <channel1||channel2>`
      });
    }
  }

  return options;
}

function resolveCommandContext(rawCommand, rawArgs = []) {
  const command = normalizeCommand(rawCommand);
  const options = parseCliOptions(rawArgs);
  if (isHelpCommand(command) || !command) {
    throw new CliError("Usage requested", {
      exitCode: 0,
      userMessage: usageText()
    });
  }

  const local2Profiles = listLocal2Profiles();

  if (command === "src2local") {
    return createSrc2LocalContext(command, options);
  }

  if (isLocal2Command(command)) {
    const local2Profile = getLocal2Profile(command);
    if (!local2Profile) {
      throw new CliError(`Unknown local2 command "${command}"`, {
        exitCode: 64,
        userMessage: `${usageText()}\n${buildUnknownCommandText(command, local2Profiles)}`
      });
    }
    if (!local2Profile.implemented) {
      throw new CliError(`Unimplemented command "${command}"`, {
        exitCode: 2,
        userMessage: `Command "${command}" is planned but not implemented yet (target=${local2Profile.label}).`
      });
    }
    return createLocal2Context(command, local2Profile, options);
  }

  throw new CliError(`Unknown command "${command}"`, {
    exitCode: 64,
    userMessage: `${usageText()}\n${buildUnknownCommandText(command, local2Profiles)}`
  });
}

module.exports = {
  parseCliOptions,
  resolveCommandContext
};
