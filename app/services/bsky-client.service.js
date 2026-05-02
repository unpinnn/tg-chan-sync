"use strict";

const DEFAULT_SERVICE_URL = "https://bsky.social";

function createBskyClientService(options = {}) {
  const identifier = String(options.identifier || "").trim();
  const appPassword = String(options.appPassword || "").trim();
  const serviceUrl = String(options.serviceUrl || DEFAULT_SERVICE_URL).trim().replace(/\/+$/, "");

  function assertConfigured() {
    const missing = [];
    if (!identifier) missing.push("BSKY_IDENTIFIER");
    if (!appPassword) missing.push("BSKY_APP_PASSWORD");
    if (missing.length > 0) {
      throw new Error(
        `Missing Bluesky credentials: ${missing.join(", ")}. Set them in .env before running local2bsky.`
      );
    }
  }

  function createClient() {
    assertConfigured();

    let did = "";
    let handle = "";
    let accessJwt = "";
    let refreshJwt = "";

    function xrpcUrl(path, query = {}) {
      const url = new URL(`${serviceUrl}${path}`);
      for (const [key, value] of Object.entries(query || {})) {
        if (value == null) continue;
        const text = String(value).trim();
        if (!text) continue;
        url.searchParams.set(key, text);
      }
      return url.toString();
    }

    async function readPayload(response) {
      const raw = await response.text().catch(() => "");
      if (!raw) return {};
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }

    async function createSession() {
      const response = await fetch(xrpcUrl("/xrpc/com.atproto.server.createSession"), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          identifier,
          password: appPassword
        })
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        const detail = String(
          payload?.message || payload?.error || response.statusText || "request failed"
        ).trim();
        throw new Error(`Bluesky login failed (${response.status}): ${detail}`);
      }
      accessJwt = String(payload?.accessJwt || "").trim();
      refreshJwt = String(payload?.refreshJwt || "").trim();
      did = String(payload?.did || "").trim();
      handle = String(payload?.handle || "").trim();
      if (!accessJwt || !refreshJwt || !did) {
        throw new Error("Bluesky login response is missing tokens or did.");
      }
      return { did, handle, accessJwt, refreshJwt };
    }

    async function refreshSession() {
      if (!refreshJwt) {
        return createSession();
      }
      const response = await fetch(xrpcUrl("/xrpc/com.atproto.server.refreshSession"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${refreshJwt}`
        }
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        return createSession();
      }
      accessJwt = String(payload?.accessJwt || "").trim();
      refreshJwt = String(payload?.refreshJwt || "").trim() || refreshJwt;
      did = String(payload?.did || did).trim();
      handle = String(payload?.handle || handle).trim();
      if (!accessJwt || !did) {
        return createSession();
      }
      return { did, handle, accessJwt, refreshJwt };
    }

    async function ensureSession() {
      if (accessJwt && did) {
        return { did, handle, accessJwt, refreshJwt };
      }
      return createSession();
    }

    async function xrpc(method, path, options = {}) {
      const authMode = options.authMode === false ? "none" : String(options.authMode || "access");
      const retries = Number.parseInt(String(options.retries || 0), 10) || 0;
      if (authMode !== "none") {
        await ensureSession();
      }

      let attempt = 0;
      for (;;) {
        attempt += 1;
        const headers = { ...(options.headers || {}) };
        if (authMode === "access") headers.Authorization = `Bearer ${accessJwt}`;
        if (authMode === "refresh") headers.Authorization = `Bearer ${refreshJwt}`;
        const body = options.body;
        const response = await fetch(xrpcUrl(path, options.query || {}), {
          method,
          headers,
          body
        });
        if (response.status === 401 && authMode === "access" && attempt <= retries + 1) {
          await refreshSession();
          continue;
        }
        const payload = await readPayload(response);
        if (!response.ok) {
          const detail = String(
            payload?.message || payload?.error || response.statusText || "request failed"
          ).trim();
          const error = new Error(
            `Bluesky API ${method} ${path} failed (${response.status}): ${detail}`
          );
          error.status = response.status;
          throw error;
        }
        return payload;
      }
    }

    async function getSession() {
      const payload = await xrpc("GET", "/xrpc/com.atproto.server.getSession", { retries: 1 });
      did = String(payload?.did || did).trim();
      handle = String(payload?.handle || handle).trim();
      return {
        did,
        handle
      };
    }

    async function getProfile(actor) {
      return xrpc("GET", "/xrpc/app.bsky.actor.getProfile", {
        query: { actor: String(actor || "").trim() },
        retries: 1
      });
    }

    async function uploadBlob(input = {}) {
      const bytes = input.bytes;
      const mimeType = String(input.mimeType || "application/octet-stream").trim();
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new Error("uploadBlob requires non-empty file bytes.");
      }
      const payload = await xrpc("POST", "/xrpc/com.atproto.repo.uploadBlob", {
        headers: { "Content-Type": mimeType },
        body: bytes,
        retries: 1
      });
      if (!payload?.blob) {
        throw new Error("Bluesky uploadBlob response missing blob payload.");
      }
      return payload.blob;
    }

    function parseAtUri(uri) {
      const raw = String(uri || "").trim();
      const match = raw.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/);
      if (!match) return null;
      return {
        repo: match[1],
        collection: match[2],
        rkey: match[3]
      };
    }

    async function createPostRecord(input = {}) {
      await ensureSession();
      const record = {
        $type: "app.bsky.feed.post",
        text: String(input.text || ""),
        createdAt: String(input.createdAt || new Date().toISOString())
      };
      if (input.reply && input.reply.root && input.reply.parent) {
        record.reply = input.reply;
      }
      if (input.embed && typeof input.embed === "object") {
        record.embed = input.embed;
      }
      if (Array.isArray(input.facets) && input.facets.length > 0) {
        record.facets = input.facets;
      }
      if (Array.isArray(input.langs) && input.langs.length > 0) {
        record.langs = input.langs;
      }
      const payload = await xrpc("POST", "/xrpc/com.atproto.repo.createRecord", {
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          repo: did,
          collection: "app.bsky.feed.post",
          record
        }),
        retries: 1
      });
      return {
        uri: String(payload?.uri || "").trim(),
        cid: String(payload?.cid || "").trim(),
        record
      };
    }

    async function putRecordByUri(input = {}) {
      await ensureSession();
      const uri = String(input.uri || "").trim();
      const record = input.record;
      if (!uri || !record || typeof record !== "object") {
        throw new Error("putRecordByUri requires uri and record object.");
      }
      const parsed = parseAtUri(uri);
      if (!parsed) {
        throw new Error(`Invalid at:// uri for putRecordByUri: ${uri}`);
      }
      const payload = {
        repo: did,
        collection: parsed.collection,
        rkey: parsed.rkey,
        record
      };
      const swapRecord = String(input.swapRecord || "").trim();
      if (swapRecord) payload.swapRecord = swapRecord;
      const result = await xrpc("POST", "/xrpc/com.atproto.repo.putRecord", {
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
        retries: 1
      });
      return {
        uri: String(result?.uri || "").trim(),
        cid: String(result?.cid || "").trim()
      };
    }

    async function deleteRecord(input = {}) {
      await ensureSession();
      const collection = String(input.collection || "").trim();
      const rkey = String(input.rkey || "").trim();
      if (!collection || !rkey) {
        throw new Error("deleteRecord requires collection and rkey.");
      }
      await xrpc("POST", "/xrpc/com.atproto.repo.deleteRecord", {
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          repo: did,
          collection,
          rkey
        }),
        retries: 1
      });
    }

    async function deletePostByUri(uri) {
      const parsed = parseAtUri(uri);
      if (!parsed || parsed.collection !== "app.bsky.feed.post") return false;
      await deleteRecord(parsed);
      return true;
    }

    async function getAuthorFeed(input = {}) {
      const actor = String(input.actor || "").trim();
      if (!actor) throw new Error("getAuthorFeed requires actor.");
      const limit = Math.max(1, Math.min(100, Number.parseInt(String(input.limit || 100), 10) || 100));
      return xrpc("GET", "/xrpc/app.bsky.feed.getAuthorFeed", {
        query: {
          actor,
          limit,
          cursor: String(input.cursor || "").trim() || undefined
        },
        retries: 1
      });
    }

    async function listOwnPostUris(limitTotal = 5000) {
      await ensureSession();
      const actor = did || identifier;
      const seen = new Set();
      const out = [];
      let cursor = "";
      while (out.length < limitTotal) {
        const payload = await getAuthorFeed({
          actor,
          cursor,
          limit: 100
        });
        const feed = Array.isArray(payload?.feed) ? payload.feed : [];
        for (const item of feed) {
          const uri = String(item?.post?.uri || "").trim();
          if (!uri || seen.has(uri)) continue;
          seen.add(uri);
          const parsed = parseAtUri(uri);
          if (!parsed) continue;
          if (parsed.collection !== "app.bsky.feed.post") continue;
          if (parsed.repo !== did) continue;
          out.push(uri);
          if (out.length >= limitTotal) break;
        }
        cursor = String(payload?.cursor || "").trim();
        if (!cursor || feed.length === 0) break;
      }
      return out;
    }

    function getIdentity() {
      return {
        did: String(did || "").trim(),
        handle: String(handle || "").trim(),
        identifier
      };
    }

    return {
      createPostRecord,
      createSession,
      deletePostByUri,
      getAuthorFeed,
      getIdentity,
      getProfile,
      getSession,
      listOwnPostUris,
      putRecordByUri,
      uploadBlob
    };
  }

  return {
    assertConfigured,
    createClient
  };
}

module.exports = {
  createBskyClientService
};
