"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const dotenv = require("dotenv");
const { loadConfig } = require("./config");
const { createStateStore } = require("./state-store");
const { createJobsStore } = require("./jobs-store");

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

const ENV_PATH_FROM_CLI = resolveEnvPathFromArgs(process.argv.slice(2));
if (ENV_PATH_FROM_CLI) {
  process.env.DOTENV_CONFIG_PATH = ENV_PATH_FROM_CLI;
  dotenv.config({ path: ENV_PATH_FROM_CLI });
} else {
  dotenv.config();
}

function parseCliOptions(rawArgs = []) {
  const options = {
    localArchiveDir: "",
    envFilePath: ""
  };
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i] || "").trim();
    if (!arg) continue;
    if (arg === "--local") {
      const next = String(rawArgs[i + 1] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new Error("Missing value for --local. Example: --local myfolder/channel-archive1");
      }
      options.localArchiveDir = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--local=")) {
      const inline = String(arg.slice("--local=".length) || "").trim();
      if (!inline) {
        throw new Error("Missing value for --local=. Example: --local=myfolder/channel-archive1");
      }
      options.localArchiveDir = inline;
      continue;
    }
    if (arg === "--env") {
      const next = String(rawArgs[i + 1] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new Error("Missing value for --env. Example: --env .env.alt");
      }
      options.envFilePath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--env=")) {
      const inline = String(arg.slice("--env=".length) || "").trim();
      if (!inline) {
        throw new Error("Missing value for --env=. Example: --env=.env.alt");
      }
      options.envFilePath = inline;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(
        `Unknown option "${arg}". Supported options: --local <archive-dir>, --env <file>`
      );
    }
  }
  return options;
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  });
  res.end(body);
}

function unauthorized(res) {
  return json(res, 401, { ok: false, error: "unauthorized" });
}

function parseRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return resolve({});
        return resolve(JSON.parse(raw));
      } catch {
        return resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function hasToken(config, req, reqUrl) {
  if (!config.token) return true;
  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader.startsWith("Bearer ") && authHeader.slice(7).trim() === config.token) return true;
  const tokenFromQuery = String(reqUrl.searchParams.get("token") || "").trim();
  return tokenFromQuery === config.token;
}

function publicJob(baseUrl, job, token) {
  return {
    id: job.id,
    title: job.title,
    text: job.text,
    original_date: job.originalDate,
    message_ids: job.messageIds,
    media_count: job.media.length,
    media: job.media.map((item) => ({
      index: item.index,
      file_name: item.fileName,
      mime_type: item.mimeType,
      size_bytes: item.sizeBytes,
      url: `${baseUrl}/jobs/${job.id}/media/${item.index}${token ? `?token=${encodeURIComponent(token)}` : ""}`
    }))
  };
}

function formatWebextLog(body = {}) {
  const at = new Date().toISOString();
  const level = String(body.level || "info").toLowerCase();
  const status = String(body.status || "").trim();
  const jobId = Number.parseInt(String(body.job_id || 0), 10);
  const tabId = Number.parseInt(String(body.tab_id || 0), 10);
  const extra = String(body.extra || "").trim();
  const parts = [`[webext-log] ${at}`, `level=${level}`];
  if (Number.isInteger(tabId) && tabId > 0) parts.push(`tab=${tabId}`);
  if (Number.isInteger(jobId) && jobId > 0) parts.push(`job=${jobId}`);
  if (status) parts.push(`status="${status}"`);
  if (extra) parts.push(`extra="${extra}"`);
  return { level, line: parts.join(" ") };
}

async function start() {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const config = loadConfig(process.env, cliOptions);
  const jobsStore = await createJobsStore(config);
  const stateStore = createStateStore(config.statePath);

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", `http://${config.host}:${config.port}`);
    if (req.method === "OPTIONS") {
      return json(res, 200, { ok: true });
    }
    if (!hasToken(config, req, reqUrl)) {
      return unauthorized(res);
    }

    if (req.method === "GET" && reqUrl.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        pair_key: jobsStore.pairKey,
        jobs_total: jobsStore.listJobs().length,
        ...stateStore.snapshot()
      });
    }

    if (req.method === "GET" && reqUrl.pathname === "/jobs/next") {
      const job = jobsStore.nextJob((id) => stateStore.isDone(id));
      if (!job) {
        return json(res, 200, { ok: true, job: null });
      }
      const baseUrl = `http://${config.host}:${config.port}`;
      return json(res, 200, {
        ok: true,
        job: publicJob(baseUrl, job, config.token)
      });
    }

    if (req.method === "POST" && reqUrl.pathname === "/logs") {
      const body = await parseRequestBody(req);
      const formatted = formatWebextLog(body);
      if (formatted.level === "error") {
        console.error(formatted.line);
      } else if (formatted.level === "warn" || formatted.level === "warning") {
        console.warn(formatted.line);
      } else {
        console.log(formatted.line);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && /^\/jobs\/\d+\/complete$/.test(reqUrl.pathname)) {
      const id = Number.parseInt(reqUrl.pathname.split("/")[2], 10);
      stateStore.markComplete(id);
      jobsStore.releaseClaim(id);
      return json(res, 200, { ok: true, id });
    }

    if (req.method === "POST" && /^\/jobs\/\d+\/fail$/.test(reqUrl.pathname)) {
      const id = Number.parseInt(reqUrl.pathname.split("/")[2], 10);
      const body = await parseRequestBody(req);
      stateStore.markFailed(id, String(body.reason || ""));
      jobsStore.releaseClaim(id);
      return json(res, 200, { ok: true, id });
    }

    if (req.method === "GET" && /^\/jobs\/\d+\/media\/\d+$/.test(reqUrl.pathname)) {
      const parts = reqUrl.pathname.split("/");
      const id = Number.parseInt(parts[2], 10);
      const index = Number.parseInt(parts[4], 10);
      const job = jobsStore.findJob(id);
      if (!job) return json(res, 404, { ok: false, error: "job_not_found" });
      const media = job.media.find((item) => item.index === index);
      if (!media) return json(res, 404, { ok: false, error: "media_not_found" });
      if (!fs.existsSync(media.absolutePath)) {
        return json(res, 404, { ok: false, error: "media_missing_on_disk" });
      }
      const stream = fs.createReadStream(media.absolutePath);
      res.writeHead(200, {
        "Content-Type": media.mimeType,
        "Content-Length": fs.statSync(media.absolutePath).size,
        "Content-Disposition": `inline; filename="${path.basename(media.fileName)}"`,
        "Access-Control-Allow-Origin": "*"
      });
      stream.pipe(res);
      return;
    }

    return json(res, 404, { ok: false, error: "not_found" });
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `[webext-serv] listening on http://${config.host}:${config.port} (pair_key=${jobsStore.pairKey} jobs=${jobsStore.listJobs().length})`
    );
    if (!config.token) {
      console.warn("[webext-serv] warning: WEBEXT_SERVER_TOKEN is empty (unauthenticated localhost API).");
    }
  });

  const shutdown = () => {
    try {
      jobsStore.close();
    } catch {
      // ignore
    }
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error("[webext-serv] fatal:", error?.message || error);
  process.exit(1);
});
