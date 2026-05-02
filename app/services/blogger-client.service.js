"use strict";

const BLOGGER_API_BASE = "https://www.googleapis.com/blogger/v3";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

function createBloggerClientService(options = {}) {
  const clientId = String(options.clientId || "").trim();
  const clientSecret = String(options.clientSecret || "").trim();
  const refreshToken = String(options.refreshToken || "").trim();

  function assertConfigured() {
    const missing = [];
    if (!clientId) missing.push("BLOGGER_CLIENT_ID");
    if (!clientSecret) missing.push("BLOGGER_CLIENT_SECRET");
    if (!refreshToken) missing.push("BLOGGER_REFRESH_TOKEN");
    if (missing.length > 0) {
      throw new Error(
        `Missing Blogger credentials: ${missing.join(", ")}. Set them in .env before running local2blogger.`
      );
    }
  }

  function createClient() {
    assertConfigured();

    let accessToken = "";
    let accessTokenExpiresAt = 0;

    async function refreshAccessToken() {
      const body = new URLSearchParams();
      body.set("client_id", clientId);
      body.set("client_secret", clientSecret);
      body.set("refresh_token", refreshToken);
      body.set("grant_type", "refresh_token");

      const response = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
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
          data?.error_description ||
            data?.error ||
            response.statusText ||
            rawText ||
            ""
        ).trim();
        const hint =
          "Check BLOGGER_CLIENT_ID/BLOGGER_CLIENT_SECRET/BLOGGER_REFRESH_TOKEN belong to the same OAuth client. " +
          "If needed, regenerate refresh token in OAuth Playground with 'Use your own OAuth credentials'.";
        throw new Error(`Blogger OAuth token refresh failed (${response.status}): ${detail}. ${hint}`);
      }
      accessToken = String(data?.access_token || "").trim();
      const expiresInSec = Math.max(30, Number.parseInt(String(data?.expires_in || 3600), 10) || 3600);
      accessTokenExpiresAt = Date.now() + expiresInSec * 1000;
      if (!accessToken) {
        throw new Error("Blogger OAuth token refresh returned empty access_token.");
      }
      return accessToken;
    }

    async function getAccessToken() {
      if (accessToken && Date.now() < accessTokenExpiresAt - 30_000) {
        return accessToken;
      }
      return refreshAccessToken();
    }

    async function requestJson(method, apiPath, options = {}) {
      const token = await getAccessToken();
      const query = new URLSearchParams();
      const queryInput = options.query || {};
      for (const [key, value] of Object.entries(queryInput)) {
        if (value == null) continue;
        const text = String(value).trim();
        if (!text) continue;
        query.set(key, text);
      }
      const url = `${BLOGGER_API_BASE}${apiPath}${query.toString() ? `?${query.toString()}` : ""}`;
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body ? { "Content-Type": "application/json; charset=utf-8" } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });

      if (response.status === 204) {
        return null;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const apiMessage =
          payload?.error?.message ||
          payload?.error_description ||
          response.statusText ||
          "request failed";
        throw new Error(`Blogger API ${method} ${apiPath} failed (${response.status}): ${apiMessage}`);
      }
      return payload;
    }

    async function resolveBlog(input = {}) {
      const blogId = String(input.blogId || "").trim();
      const blogUrl = String(input.blogUrl || "").trim();
      if (!blogId && !blogUrl) {
        throw new Error("Blogger target requires BLOGGER_BLOG_ID or BLOGGER_BLOG_URL.");
      }
      if (blogId) {
        const data = await requestJson("GET", `/blogs/${encodeURIComponent(blogId)}`);
        return {
          id: String(data?.id || "").trim(),
          name: String(data?.name || "").trim(),
          url: String(data?.url || "").trim()
        };
      }
      const data = await requestJson("GET", "/blogs/byurl", { query: { url: blogUrl } });
      return {
        id: String(data?.id || "").trim(),
        name: String(data?.name || "").trim(),
        url: String(data?.url || "").trim()
      };
    }

    async function listAllPosts(blogId) {
      const out = [];
      let pageToken = "";
      do {
        const payload = await requestJson("GET", `/blogs/${encodeURIComponent(blogId)}/posts`, {
          query: {
            maxResults: 500,
            fetchBodies: false,
            pageToken: pageToken || undefined
          }
        });
        const items = Array.isArray(payload?.items) ? payload.items : [];
        for (const item of items) {
          out.push({
            id: String(item?.id || "").trim(),
            url: String(item?.url || "").trim(),
            title: String(item?.title || "").trim()
          });
        }
        pageToken = String(payload?.nextPageToken || "").trim();
      } while (pageToken);
      return out;
    }

    async function deletePost(blogId, postId) {
      await requestJson("DELETE", `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(postId)}`);
    }

    async function createPost(blogId, input = {}) {
      const payload = {
        title: String(input.title || "").trim() || "Untitled",
        content: String(input.content || ""),
        labels: Array.isArray(input.labels) ? input.labels.filter((x) => String(x || "").trim()) : []
      };
      const post = await requestJson("POST", `/blogs/${encodeURIComponent(blogId)}/posts`, {
        query: {
          isDraft: input.isDraft ? "true" : "false"
        },
        body: payload
      });
      return {
        id: String(post?.id || "").trim(),
        url: String(post?.url || "").trim(),
        title: String(post?.title || "").trim(),
        content: String(post?.content || "")
      };
    }

    async function updatePost(blogId, postId, input = {}) {
      const payload = {
        title: String(input.title || "").trim() || "Untitled",
        content: String(input.content || ""),
        labels: Array.isArray(input.labels) ? input.labels.filter((x) => String(x || "").trim()) : []
      };
      const post = await requestJson(
        "PUT",
        `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(postId)}`,
        {
          query: {
            publish: input.publish ? "true" : "false"
          },
          body: payload
        }
      );
      return {
        id: String(post?.id || "").trim(),
        url: String(post?.url || "").trim(),
        title: String(post?.title || "").trim(),
        content: String(post?.content || "")
      };
    }

    return {
      resolveBlog,
      listAllPosts,
      deletePost,
      createPost,
      updatePost
    };
  }

  return {
    assertConfigured,
    createClient
  };
}

module.exports = {
  createBloggerClientService
};
