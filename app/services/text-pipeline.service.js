"use strict";

const fs = require("fs");
const path = require("path");

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPosixRelativePath(absolutePath) {
  const rel = path.relative(process.cwd(), absolutePath);
  return rel.split(path.sep).join("/");
}

function compileRegexEntry(entry, keyName, idx) {
  if (entry == null) {
    return null;
  }
  if (typeof entry === "string") {
    const pattern = entry;
    const flags = "g";
    try {
      return new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`${keyName}[${idx}] invalid regex "${pattern}": ${error?.message || error}`);
    }
  }
  if (typeof entry === "object") {
    const pattern = String(entry.pattern || "");
    const flags = String(entry.flags || "g");
    if (!pattern) {
      return null;
    }
    try {
      return new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`${keyName}[${idx}] invalid regex "${pattern}": ${error?.message || error}`);
    }
  }
  return null;
}

function loadTextRules(filePath) {
  const empty = {
    removeLiteral: [],
    replaceLiteral: [],
    removeRegex: [],
    replaceRegex: []
  };
  if (!filePath) {
    return empty;
  }
  if (!fs.existsSync(filePath)) {
    console.warn(`[text-rules] file not found: ${toPosixRelativePath(filePath)} (continuing with no rules)`);
    return empty;
  }

  let rawJson;
  try {
    rawJson = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `[text-rules] failed to parse ${toPosixRelativePath(filePath)}: ${error?.message || error}`
    );
  }

  const removeLiteral = toArray(rawJson["remove-literal"])
    .map((x) => String(x || ""))
    .filter((x) => x.length > 0);

  const replaceLiteral = toArray(rawJson["replace-literal"])
    .map((x) => ({
      from: String(x?.from || ""),
      to: String(x?.to || "")
    }))
    .filter((x) => x.from.length > 0);

  const removeRegex = toArray(rawJson["remove-regex"])
    .map((entry, idx) => compileRegexEntry(entry, "remove-regex", idx))
    .filter(Boolean);

  const replaceRegex = toArray(rawJson["replace-regex"])
    .map((entry, idx) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const regex = compileRegexEntry(entry, "replace-regex", idx);
      if (!regex) return null;
      return {
        regex,
        replacement: String(entry.replacement || "")
      };
    })
    .filter(Boolean);

  return {
    removeLiteral,
    replaceLiteral,
    removeRegex,
    replaceRegex
  };
}

function applyTextRules(text, textRules) {
  let value = String(text || "");
  if (!value) {
    return value;
  }

  for (const needle of textRules.removeLiteral) {
    value = value.split(needle).join("");
  }
  for (const pair of textRules.replaceLiteral) {
    value = value.split(pair.from).join(pair.to);
  }
  for (const regex of textRules.removeRegex) {
    value = value.replace(regex, "");
  }
  for (const rule of textRules.replaceRegex) {
    value = value.replace(rule.regex, rule.replacement);
  }

  return value;
}

function splitTrailingPunctuation(urlToken) {
  let core = String(urlToken || "");
  let trailing = "";
  while (core.length > 0 && /[)\].,!?;:]/.test(core.slice(-1))) {
    trailing = core.slice(-1) + trailing;
    core = core.slice(0, -1);
  }
  return { core, trailing };
}

function cleanAndRewriteUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  for (const key of Array.from(parsed.searchParams.keys())) {
    if (
      /^utm_/i.test(key) ||
      /^trk(?:_|$)/i.test(key) ||
      /^original(?:_)?subdomain$/i.test(key)
    ) {
      parsed.searchParams.delete(key);
    }
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname === "t.me" || hostname === "telegram.me") {
    return "";
  }

  if (parsed.searchParams.has("single")) {
    parsed.searchParams.delete("single");
  }

  return parsed.toString();
}

function createTextPipeline(options = {}) {
  const textRulesFile = String(options.textRulesFile || "").trim();
  const isSrc2Local = !!options.isSrc2Local;
  const autoPrependLine1 = String(options.autoPrependLine1 || "");
  const autoPrependLine2 = String(options.autoPrependLine2 || "");
  const autoAppendLine1 = String(options.autoAppendLine1 || "");
  const autoAppendLine2 = String(options.autoAppendLine2 || "");
  const toDateOnlyStringSafe =
    typeof options.toDateOnlyStringSafe === "function"
      ? options.toDateOnlyStringSafe
      : () => "";

  const textRules = loadTextRules(textRulesFile);

  function cleanAndRewriteText(text) {
    const value = String(text || "");
    if (!value) return value;

    const urlPattern = /https?:\/\/[^\s<>"'`]+/gi;
    const rewritten = value.replace(urlPattern, (match) => {
      const { core, trailing } = splitTrailingPunctuation(match);
      const cleanedCore = cleanAndRewriteUrl(core);
      return cleanedCore ? `${cleanedCore}${trailing}` : "";
    });
    const compact = rewritten
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();
    return applyTextRules(compact, textRules);
  }

  function buildPostAutoTemplateLines(messages, line1, line2) {
    const originalDate = toDateOnlyStringSafe(messages?.[0]?.date);
    const templatePattern = /\$\{ORIGINAL_POST_DATE\}/g;
    const lines = [line1, line2]
      .map((line) => String(line || ""))
      .map((line) => line.replace(templatePattern, originalDate))
      .filter((line) => line.trim().length > 0);
    return lines;
  }

  function applyPostAutoPrependLines(messages, textByMessageId) {
    if (isSrc2Local) {
      return;
    }
    const lines = buildPostAutoTemplateLines(messages, autoPrependLine1, autoPrependLine2);
    if (!lines.length || !Array.isArray(messages) || messages.length === 0) {
      return;
    }

    let targetMessageId = Number(messages[0]?.id || 0);
    for (const message of messages) {
      const id = Number(message?.id || 0);
      if (!id) continue;
      const text = String(textByMessageId?.get(id) || "");
      if (text.trim().length > 0) {
        targetMessageId = id;
        break;
      }
    }
    if (!targetMessageId) {
      return;
    }

    const base = String(textByMessageId.get(targetMessageId) || "");
    const prefix = lines.join("\n");
    const combined = base.trim().length > 0 ? `${prefix}\n${base}` : prefix;
    textByMessageId.set(targetMessageId, combined);
  }

  function applyPostAutoAppendLines(messages, textByMessageId) {
    if (isSrc2Local) {
      return;
    }
    const lines = buildPostAutoTemplateLines(messages, autoAppendLine1, autoAppendLine2);
    if (!lines.length || !Array.isArray(messages) || messages.length === 0) {
      return;
    }

    let targetMessageId = Number(messages[0]?.id || 0);
    for (const message of messages) {
      const id = Number(message?.id || 0);
      if (!id) continue;
      const text = String(textByMessageId?.get(id) || "");
      if (text.trim().length > 0) {
        targetMessageId = id;
      }
    }
    if (!targetMessageId) {
      return;
    }

    const base = String(textByMessageId.get(targetMessageId) || "");
    const suffix = lines.join("\n");
    const combined = base.trim().length > 0 ? `${base}\n${suffix}` : suffix;
    textByMessageId.set(targetMessageId, combined);
  }

  return {
    cleanAndRewriteText,
    applyPostAutoPrependLines,
    applyPostAutoAppendLines
  };
}

module.exports = {
  createTextPipeline
};
