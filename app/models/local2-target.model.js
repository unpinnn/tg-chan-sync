"use strict";

const LOCAL2_TARGETS = {
  local2dest: {
    key: "dest",
    label: "telegram-destination",
    implemented: true
  },
  local2x: {
    key: "x",
    label: "x-twitter",
    implemented: true
  },
  "local2x-web": {
    key: "x-web",
    label: "x-web-browser",
    implemented: true
  },
  local2blogger: {
    key: "blogger",
    label: "blogger",
    implemented: true
  },
  "local2wp.com": {
    key: "wp-com",
    label: "wordpress-com",
    implemented: true
  },
  local2bsky: {
    key: "bsky",
    label: "bluesky",
    implemented: true
  },
  local2insta: {
    key: "insta",
    label: "instagram",
    implemented: false
  }
};

function isLocal2Command(command) {
  return String(command || "").toLowerCase().startsWith("local2");
}

function getLocal2Profile(command) {
  const normalized = String(command || "").toLowerCase().trim();
  return LOCAL2_TARGETS[normalized] || null;
}

function listLocal2Commands() {
  return Object.keys(LOCAL2_TARGETS);
}

function listLocal2Profiles() {
  return listLocal2Commands().map((command) => ({
    command,
    ...LOCAL2_TARGETS[command]
  }));
}

module.exports = {
  getLocal2Profile,
  isLocal2Command,
  listLocal2Commands,
  listLocal2Profiles
};
