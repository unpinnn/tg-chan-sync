"use strict";

const WP_OAUTH_TOKEN_URL = "https://public-api.wordpress.com/oauth2/token";
const WP_REST_BASE = "https://public-api.wordpress.com/rest/v1.1";

function createWpComClientService(options = {}) {
  const clientId = String(options.clientId || "").trim();
  const clientSecret = String(options.clientSecret || "").trim();
  const username = String(options.username || "").trim();
  const appPassword = String(options.appPassword || "").trim();

  function assertConfigured() {
    const missing = [];
    if (!clientId) missing.push("WP_COM_CLIENT_ID");
    if (!clientSecret) missing.push("WP_COM_CLIENT_SECRET");
    if (!username) missing.push("WP_COM_USERNAME");
    if (!appPassword) missing.push("WP_COM_APP_PASSWORD");
    if (missing.length > 0) {
      throw new Error(
        `Missing WordPress.com credentials: ${missing.join(", ")}. Set them in .env before running local2wp.com.`
      );
    }
  }

  function createClient() {
    assertConfigured();
    let accessToken = "";
    let accessTokenExpiresAt = 0;

    async function requestToken() {
      const body = new URLSearchParams();
      body.set("client_id", clientId);
      body.set("client_secret", clientSecret);
      body.set("grant_type", "password");
      body.set("username", username);
      body.set("password", appPassword);

      const response = await fetch(WP_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      const rawText = await response.text().catch(() => "");
      let data = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = {};
      }
      if (!response.ok) {
        const detail = String(
          data?.error_description || data?.error || response.statusText || rawText || ""
        ).trim();
        throw new Error(`WordPress.com OAuth token request failed (${response.status}): ${detail}`);
      }
      const token = String(data?.access_token || "").trim();
      if (!token) {
        throw new Error("WordPress.com OAuth token response did not include access_token.");
      }
      accessToken = token;
      const expiresInSec = Math.max(30, Number.parseInt(String(data?.expires_in || 3600), 10) || 3600);
      accessTokenExpiresAt = Date.now() + expiresInSec * 1000;
      return accessToken;
    }

    async function getAccessToken() {
      if (accessToken && Date.now() < accessTokenExpiresAt - 30_000) {
        return accessToken;
      }
      return requestToken();
    }

    async function requestJson(method, path, options = {}) {
      const token = await getAccessToken();
      const query = new URLSearchParams();
      const queryInput = options.query || {};
      for (const [k, v] of Object.entries(queryInput)) {
        if (v == null) continue;
        const text = String(v).trim();
        if (!text) continue;
        query.set(k, text);
      }
      const url = `${WP_REST_BASE}${path}${query.toString() ? `?${query.toString()}` : ""}`;
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.formBody
            ? { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" }
            : {})
        },
        body: options.formBody
          ? new URLSearchParams(options.formBody).toString()
          : options.body
            ? JSON.stringify(options.body)
            : undefined
      });
      const rawText = await response.text().catch(() => "");
      let payload = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const detail = String(
          payload?.error ||
            payload?.message ||
            payload?.error_description ||
            response.statusText ||
            rawText ||
            ""
        ).trim();
        const error = new Error(`WordPress.com API ${method} ${path} failed (${response.status}): ${detail}`);
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    async function requestMultipart(path, formData, options = {}) {
      const token = await getAccessToken();
      const query = new URLSearchParams();
      const queryInput = options.query || {};
      for (const [k, v] of Object.entries(queryInput)) {
        if (v == null) continue;
        const text = String(v).trim();
        if (!text) continue;
        query.set(k, text);
      }
      const url = `${WP_REST_BASE}${path}${query.toString() ? `?${query.toString()}` : ""}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: formData
      });
      const rawText = await response.text().catch(() => "");
      let payload = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const maybeErrors = [];
        const errorsValue = payload?.errors;
        if (Array.isArray(errorsValue)) {
          for (const e of errorsValue) {
            const t = String(e || "").trim();
            if (t) maybeErrors.push(t);
          }
        } else if (errorsValue && typeof errorsValue === "object") {
          for (const v of Object.values(errorsValue)) {
            const t = String(v || "").trim();
            if (t) maybeErrors.push(t);
          }
        }
        const mediaErrorsValue = payload?.media_errors;
        if (Array.isArray(mediaErrorsValue)) {
          for (const e of mediaErrorsValue) {
            const t = String(e || "").trim();
            if (t) maybeErrors.push(t);
          }
        } else if (mediaErrorsValue && typeof mediaErrorsValue === "object") {
          for (const v of Object.values(mediaErrorsValue)) {
            const t = String(v || "").trim();
            if (t) maybeErrors.push(t);
          }
        }
        const detail = String(
          payload?.error ||
            payload?.message ||
            payload?.error_description ||
            response.statusText ||
            rawText ||
            ""
        ).trim();
        const detailsSuffix = maybeErrors.length ? ` | ${maybeErrors.join(" ; ")}` : "";
        const error = new Error(
          `WordPress.com API POST ${path} failed (${response.status}): ${detail}${detailsSuffix}`
        );
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    async function getSite(siteIdOrDomain) {
      const site = String(siteIdOrDomain || "").trim();
      if (!site) {
        throw new Error("WordPress.com site identifier is empty.");
      }
      const payload = await requestJson("GET", `/sites/${encodeURIComponent(site)}`);
      return {
        id: String(payload?.ID || payload?.id || "").trim(),
        url: String(payload?.URL || payload?.url || "").trim(),
        name: String(payload?.name || "").trim(),
        capabilities: payload?.capabilities || {},
        allowedFileTypes: Array.isArray(payload?.options?.allowed_file_types)
          ? payload.options.allowed_file_types.map((x) => String(x || "").toLowerCase()).filter(Boolean)
          : []
      };
    }

    async function listPosts(siteIdOrDomain, options = {}) {
      const site = String(siteIdOrDomain || "").trim();
      const number = Number.parseInt(String(options.number || 100), 10) || 100;
      const page = Number.parseInt(String(options.page || 1), 10) || 1;
      return requestJson("GET", `/sites/${encodeURIComponent(site)}/posts`, {
        query: {
          number,
          page,
          status: String(options.status || "any")
        }
      });
    }

    async function createPost(siteIdOrDomain, payload = {}) {
      const site = String(siteIdOrDomain || "").trim();
      const form = {
        title: String(payload.title || ""),
        content: String(payload.content || ""),
        status: String(payload.status || "publish")
      };
      if (Array.isArray(payload.tags) && payload.tags.length > 0) {
        form.tags = payload.tags.join(",");
      }
      return requestJson("POST", `/sites/${encodeURIComponent(site)}/posts/new`, {
        formBody: form
      });
    }

    async function updatePost(siteIdOrDomain, postId, payload = {}) {
      const site = String(siteIdOrDomain || "").trim();
      const pid = String(postId || "").trim();
      const form = {
        title: String(payload.title || ""),
        content: String(payload.content || ""),
        status: String(payload.status || "publish")
      };
      if (Array.isArray(payload.tags) && payload.tags.length > 0) {
        form.tags = payload.tags.join(",");
      }
      return requestJson("POST", `/sites/${encodeURIComponent(site)}/posts/${encodeURIComponent(pid)}`, {
        formBody: form
      });
    }

    async function deletePost(siteIdOrDomain, postId) {
      const site = String(siteIdOrDomain || "").trim();
      const pid = String(postId || "").trim();
      return requestJson(
        "POST",
        `/sites/${encodeURIComponent(site)}/posts/${encodeURIComponent(pid)}/delete`
      );
    }

    async function listMedia(siteIdOrDomain, options = {}) {
      const site = String(siteIdOrDomain || "").trim();
      const number = Number.parseInt(String(options.number || 100), 10) || 100;
      const page = Number.parseInt(String(options.page || 1), 10) || 1;
      return requestJson("GET", `/sites/${encodeURIComponent(site)}/media`, {
        query: {
          number,
          page
        }
      });
    }

    async function deleteMedia(siteIdOrDomain, mediaId) {
      const site = String(siteIdOrDomain || "").trim();
      const mid = String(mediaId || "").trim();
      return requestJson(
        "POST",
        `/sites/${encodeURIComponent(site)}/media/${encodeURIComponent(mid)}/delete`
      );
    }

    async function uploadMedia(siteIdOrDomain, input = {}) {
      const site = String(siteIdOrDomain || "").trim();
      const fileName = String(input.fileName || "upload.bin").trim();
      const mimeType = String(input.mimeType || "application/octet-stream").trim();
      const bytes = input.bytes;
      if (!bytes || !Buffer.isBuffer(bytes)) {
        throw new Error("uploadMedia requires file bytes.");
      }

      const form = new FormData();
      const blob = new Blob([bytes], { type: mimeType });
      form.append("media[]", blob, fileName);

      const payload = await requestMultipart(`/sites/${encodeURIComponent(site)}/media/new`, form);
      const mediaList = Array.isArray(payload?.media)
        ? payload.media
        : payload?.media && typeof payload.media === "object"
          ? Object.values(payload.media)
          : [];
      const first = mediaList[0] || null;
      const url = String(first?.URL || first?.url || first?.guid || "").trim();
      const mediaId = String(first?.ID || first?.id || "").trim();
      if (!url) {
        throw new Error("WordPress.com media upload response did not include media URL.");
      }
      return { url, mediaId, raw: first };
    }

    return {
      getSite,
      listPosts,
      createPost,
      updatePost,
      deletePost,
      listMedia,
      deleteMedia,
      uploadMedia
    };
  }

  return {
    assertConfigured,
    createClient
  };
}

module.exports = {
  createWpComClientService
};
