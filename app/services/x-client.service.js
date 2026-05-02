"use strict";

function createXClientService(options = {}) {
  const TwitterApi = options.TwitterApi;
  const appKey = String(options.appKey || "").trim();
  const appSecret = String(options.appSecret || "").trim();
  const accessToken = String(options.accessToken || "").trim();
  const accessSecret = String(options.accessSecret || "").trim();

  if (!TwitterApi) {
    throw new Error("createXClientService: TwitterApi is required");
  }

  function assertConfigured() {
    const missing = [];
    if (!appKey) missing.push("X_APP_KEY");
    if (!appSecret) missing.push("X_APP_SECRET");
    if (!accessToken) missing.push("X_ACCESS_TOKEN");
    if (!accessSecret) missing.push("X_ACCESS_SECRET");
    if (missing.length > 0) {
      throw new Error(
        `Missing X credentials: ${missing.join(", ")}. Set them in .env before running local2x.`
      );
    }
  }

  function createClient() {
    assertConfigured();
    const client = new TwitterApi({
      appKey,
      appSecret,
      accessToken,
      accessSecret
    });
    return client.readWrite;
  }

  return {
    assertConfigured,
    createClient
  };
}

module.exports = {
  createXClientService
};
