"use strict";

const path = require("path");
const dotenv = require("dotenv");
const { runApp } = require("./controllers/app.controller");
const { handleFatalError } = require("./controllers/error.controller");

function resolveEnvPathFromArgs(rawArgs = []) {
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i] || "").trim();
    if (!arg) continue;
    if (arg === "--env") {
      const next = String(rawArgs[i + 1] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new Error("Missing value for --env. Example: --env .env.alt");
      }
      return path.resolve(next);
    }
    if (arg.startsWith("--env=")) {
      const inline = String(arg.slice("--env=".length) || "").trim();
      if (!inline) {
        throw new Error("Missing value for --env=. Example: --env=.env.alt");
      }
      return path.resolve(inline);
    }
  }
  return "";
}

try {
  const envPathFromCli = resolveEnvPathFromArgs(process.argv.slice(3));
  if (envPathFromCli) {
    process.env.DOTENV_CONFIG_PATH = envPathFromCli;
    dotenv.config({ path: envPathFromCli });
  } else {
    dotenv.config();
  }
  runApp().catch((error) => {
    const code = handleFatalError(error);
    process.exitCode = code;
  });
} catch (error) {
  const code = handleFatalError(error);
  process.exitCode = code;
}
