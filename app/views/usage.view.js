"use strict";

function toProfileRows(local2ProfilesOrCommands) {
  if (!Array.isArray(local2ProfilesOrCommands)) {
    return [];
  }
  if (local2ProfilesOrCommands.length === 0) {
    return [];
  }
  if (typeof local2ProfilesOrCommands[0] === "string") {
    return local2ProfilesOrCommands.map((command) => ({
      command: String(command || "").trim(),
      implemented: true,
      label: ""
    }));
  }
  return local2ProfilesOrCommands.map((profile) => ({
    command: String(profile?.command || "").trim(),
    implemented: !!profile?.implemented,
    label: String(profile?.label || "").trim()
  }));
}

function buildUsageText(local2ProfilesOrCommands) {
  const rows = toProfileRows(local2ProfilesOrCommands);
  const local2Commands = rows.map((x) => x.command).filter(Boolean);
  const usageParts = ["src2local", ...local2Commands];
  const lines = [`Usage: node app/main.js <${usageParts.join("|")}> [--local <archive-dir>]`];

  if (rows.length > 0) {
    lines.push("");
    lines.push("Commands:");
    lines.push("  src2local (implemented)");
    for (const row of rows) {
      const state = row.implemented ? "implemented" : "planned";
      const label = row.label ? ` target=${row.label}` : "";
      lines.push(`  ${row.command} (${state}${label})`);
    }
  }
  lines.push("");
  lines.push("Options:");
  lines.push("  --local <archive-dir>   Override default local archive directory (default: channel-archive)");
  lines.push("  --env <file>            Load environment variables from a specific .env file");
  lines.push("  --dest <channel>        Override DEST_CHANNEL for this run");
  lines.push("  --dests <a||b||c>       local2dest only: run against multiple destination channels");

  return lines.join("\n");
}

function buildUnknownCommandText(command, local2ProfilesOrCommands) {
  const rows = toProfileRows(local2ProfilesOrCommands);
  const known = rows.map((x) => x.command).filter(Boolean);
  const supported = ["src2local", ...known].join(", ");
  return `Unknown command "${String(command || "")}". Supported: ${supported}`;
}

module.exports = {
  buildUnknownCommandText,
  buildUsageText
};
