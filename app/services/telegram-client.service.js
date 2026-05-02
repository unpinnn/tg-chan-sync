"use strict";

const fs = require("fs");

function createTelegramClientService(options = {}) {
  const Api = options.Api;
  const CustomFile = options.CustomFile;
  const TelegramClient = options.TelegramClient;
  const StringSession = options.StringSession;
  const input = options.input;
  const apiId = Number(options.apiId || 0);
  const apiHash = String(options.apiHash || "");
  const gramjsLogLevel = String(options.gramjsLogLevel || "error");
  const withFloodWaitRetry = options.withFloodWaitRetry;
  const getSessionString = options.getSessionString;

  function extractInviteHash(peerInput) {
    const value = String(peerInput || "").trim();
    const m = value.match(
      /^(?:https?:\/\/)?(?:t(?:elegram)?\.me)\/\+([A-Za-z0-9_-]+)(?:\/.*)?$/i
    );
    return m ? m[1] : "";
  }

  function extractUsernameFromUrl(peerInput) {
    const value = String(peerInput || "").trim();
    if (!value) return "";
    const m = value.match(
      /^(?:https?:\/\/)?(?:t(?:elegram)?\.me)\/([A-Za-z0-9_]{5,})(?:\/.*)?$/i
    );
    if (!m) return "";
    if (m[1].startsWith("+")) return "";
    return `@${m[1]}`;
  }

  function extractChannelHandle(peerInput) {
    const value = String(peerInput || "").trim();
    if (!value) return "";
    if (value.startsWith("@")) {
      return value.slice(1).trim();
    }
    const fromUrl = extractUsernameFromUrl(value);
    if (fromUrl) {
      return fromUrl.slice(1).trim();
    }
    return "";
  }

  function sanitizeChannelHandle(rawHandle) {
    let value = String(rawHandle || "")
      .trim()
      .replace(/^@+/, "")
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!value) return "";
    if (!/^[A-Za-z]/.test(value)) {
      value = `chan_${value}`;
    }
    if (value.length > 32) {
      value = value.slice(0, 32);
    }
    if (value.length < 5) {
      return "";
    }
    return value;
  }

  function usernameFromInput(peerInput) {
    const value = String(peerInput || "").trim();
    if (!value) return "";
    if (value.startsWith("@")) return value.slice(1).toLowerCase();
    const fromUrl = extractUsernameFromUrl(value);
    if (fromUrl) return fromUrl.slice(1).toLowerCase();
    return "";
  }

  async function resolvePeer(client, peerInput, label) {
    const inputValue = String(peerInput || "").trim();
    const inviteHash = extractInviteHash(inputValue);

    if (inviteHash) {
      const inviteInfo = await withFloodWaitRetry(
        () => client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash })),
        `check invite for ${label}`
      );

      if (inviteInfo.className === "ChatInviteAlready") {
        return inviteInfo.chat;
      }

      console.log(`${label}: joining chat using invite link...`);
      const joinResult = await withFloodWaitRetry(
        () => client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash })),
        `join invite for ${label}`
      );

      if (Array.isArray(joinResult.chats) && joinResult.chats.length > 0) {
        return joinResult.chats[0];
      }

      throw new Error(`Joined invite for ${label}, but no chat entity was returned.`);
    }

    const username = extractUsernameFromUrl(inputValue);
    if (username) {
      return withFloodWaitRetry(() => client.getEntity(username), `resolve ${label}`);
    }

    return withFloodWaitRetry(() => client.getEntity(inputValue), `resolve ${label}`);
  }

  async function createClient() {
    const session = new StringSession(getSessionString());
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5
    });
    if (["none", "error", "warn", "info", "debug"].includes(gramjsLogLevel)) {
      client.setLogLevel(gramjsLogLevel);
    } else {
      client.setLogLevel("error");
    }

    await client.start({
      phoneNumber: async () => input.text("Phone number (international format): "),
      password: async () => input.text("2FA password (if enabled): "),
      phoneCode: async () => input.text("Code you received: "),
      onError: (err) => {
        console.error("Telegram auth error:", err);
      }
    });

    const currentSession = String(client.session.save() || "").trim();
    const hasEnvSession = !!String(process.env.TG_SESSION || "").trim();
    if (currentSession && !hasEnvSession) {
      console.log("No TG_SESSION was provided in env.");
      console.log("Set this in your .env to reuse login without re-auth:");
      console.log(`TG_SESSION=${currentSession}`);
    }

    return client;
  }

  function extractCreatedChannelFromUpdates(updates) {
    const chats = Array.isArray(updates?.chats) ? updates.chats : [];
    const fromChats = chats.find((chat) => chat && (chat.className === "Channel" || chat.broadcast));
    if (fromChats) return fromChats;
    return chats[0] || null;
  }

  function parseRpcErrorCode(error) {
    const raw = String(error?.errorMessage || error?.message || "").toUpperCase();
    if (raw.includes("USERNAME_OCCUPIED")) return "HANDLE_OCCUPIED";
    if (raw.includes("USERNAME_INVALID")) return "HANDLE_INVALID";
    if (raw.includes("CHANNELS_ADMIN_PUBLIC_TOO_MUCH")) return "PUBLIC_LIMIT_REACHED";
    return "UNKNOWN";
  }

  async function assignChannelHandle(client, channelEntity, handle) {
    const desired = sanitizeChannelHandle(handle);
    if (!desired) {
      const err = new Error("Destination channel handle is empty or invalid after normalization.");
      err.code = "HANDLE_INVALID";
      throw err;
    }
    try {
      await withFloodWaitRetry(
        () =>
          client.invoke(
            new Api.channels.UpdateUsername({
              channel: channelEntity,
              username: desired
            })
          ),
        `assign destination channel handle @${desired}`
      );
      return desired;
    } catch (error) {
      const code = parseRpcErrorCode(error);
      const wrapped = new Error(
        `Failed assigning destination channel handle @${desired}: ${String(
          error?.errorMessage || error?.message || error
        )}`
      );
      wrapped.code = code;
      throw wrapped;
    }
  }

  async function createDestinationChannel(client, input = {}) {
    const title = String(input.title || "").trim() || "Channel Copy";
    const about = String(input.about || "").trim();
    const publicChannel = !!input.publicChannel;
    const handleBase = String(input.handleBase || "").trim();
    const handleAutoIncrement = !!input.handleAutoIncrement;
    const failIfHandleTaken = !!input.failIfHandleTaken;
    const maxAttempts = Math.max(
      1,
      Number.parseInt(String(input.maxAttempts || 50), 10) || 50
    );
    const logInfo = typeof input.logInfo === "function" ? input.logInfo : () => {};
    const disableReactions = !!input.disableReactions;
    const iconPath = String(input.iconPath || "").trim();

    const createResult = await withFloodWaitRetry(
      () =>
        client.invoke(
          new Api.channels.CreateChannel({
            title,
            about,
            broadcast: true,
            megagroup: false
          })
        ),
      "create destination channel"
    );
    const createdChannel = extractCreatedChannelFromUpdates(createResult);
    if (!createdChannel) {
      throw new Error("Created destination channel, but no channel entity returned.");
    }

    const output = {
      channel: createdChannel,
      createdAsPublic: false,
      assignedHandle: "",
      attempts: []
    };

    if (iconPath) {
      try {
        if (!fs.existsSync(iconPath)) {
          throw new Error(`DEST_CREATE_ICON file not found: ${iconPath}`);
        }
        const stat = fs.statSync(iconPath);
        if (!stat.isFile()) {
          throw new Error(`DEST_CREATE_ICON must be a file path: ${iconPath}`);
        }
        if (!CustomFile) {
          throw new Error("CustomFile uploader is unavailable; cannot set DEST_CREATE_ICON.");
        }
        const uploadFile = await withFloodWaitRetry(
          () =>
            client.uploadFile({
              file: new CustomFile(iconPath.split(/[\\/]/).pop() || "icon", stat.size, iconPath),
              workers: 1
            }),
          "upload destination channel icon"
        );
        await withFloodWaitRetry(
          () =>
            client.invoke(
              new Api.channels.EditPhoto({
                channel: createdChannel,
                photo: new Api.InputChatUploadedPhoto({
                  file: uploadFile
                })
              })
            ),
          "set destination channel icon"
        );
        logInfo(`[dest-create] destination channel icon applied from ${iconPath}`);
      } catch (error) {
        logInfo(
          `[dest-create] icon apply failed (${iconPath}): ${String(
            error?.message || error
          )}; continuing without icon`
        );
      }
    }

    if (disableReactions) {
      try {
        await withFloodWaitRetry(
          () =>
            client.invoke(
              new Api.messages.SetChatAvailableReactions({
                peer: createdChannel,
                availableReactions: new Api.ChatReactionsNone()
              })
            ),
          "disable destination channel reactions"
        );
        logInfo("[dest-create] destination channel reactions disabled");
      } catch (error) {
        logInfo(
          `[dest-create] disable reactions failed: ${String(
            error?.message || error
          )}; continuing with reactions unchanged`
        );
      }
    }

    if (!publicChannel) {
      return output;
    }

    const baseHandle = sanitizeChannelHandle(handleBase);
    if (!baseHandle) {
      throw new Error(
        "DEST_CREATE_PUBLIC=1 requires DEST_CHANNEL with a valid destination channel handle (t.me/<handle> or @handle)."
      );
    }

    const candidates = [];
    candidates.push(baseHandle);
    if (handleAutoIncrement) {
      for (let i = 1; i <= maxAttempts; i += 1) {
        const suffix = String(i);
        const trimmed = baseHandle.slice(0, Math.max(1, 32 - suffix.length));
        const candidate = `${trimmed}${suffix}`;
        if (!candidates.includes(candidate)) {
          candidates.push(candidate);
        }
      }
    }

    for (const candidate of candidates) {
      output.attempts.push(candidate);
      try {
        const assigned = await assignChannelHandle(client, createdChannel, candidate);
        output.createdAsPublic = true;
        output.assignedHandle = assigned;
        logInfo(`[dest-create] assigned destination channel handle @${assigned}`);
        return output;
      } catch (error) {
        const code = String(error?.code || "");
        if (code === "HANDLE_OCCUPIED" || code === "HANDLE_INVALID") {
          continue;
        }
        throw error;
      }
    }

    if (failIfHandleTaken) {
      throw new Error(
        `Could not assign destination channel handle. Tried: ${output.attempts.join(", ")}`
      );
    }

    logInfo(
      `[dest-create] could not assign public destination channel handle; continuing as private. Tried: ${output.attempts.join(
        ", "
      )}`
    );
    return output;
  }

  function isLikelyWritableByEntity(destination) {
    if (!destination) return false;
    if (String(destination.className || "").toLowerCase().includes("forbidden")) {
      return false;
    }
    if (destination.creator) return true;
    if (destination.megagroup) {
      return true;
    }
    if (destination.adminRights && destination.adminRights.postMessages) {
      return true;
    }
    return false;
  }

  async function checkDestinationWriteAccess(client, destination) {
    const fallback = {
      writable: isLikelyWritableByEntity(destination),
      reason: isLikelyWritableByEntity(destination)
        ? "entity-rights-indicate-writable"
        : "entity-rights-indicate-not-writable"
    };
    if (!client || !destination) {
      return { writable: false, reason: "missing-client-or-destination" };
    }
    if (fallback.writable) {
      return fallback;
    }

    try {
      const result = await withFloodWaitRetry(
        () =>
          client.invoke(
            new Api.channels.GetParticipant({
              channel: destination,
              participant: new Api.InputPeerSelf()
            })
          ),
        "check destination write access"
      );
      const participant = result?.participant || null;
      const cls = String(participant?.className || "");
      if (/Creator/i.test(cls)) {
        return { writable: true, reason: "participant-creator" };
      }
      if (destination.megagroup) {
        const bannedSend = !!participant?.bannedRights?.sendMessages;
        return {
          writable: !bannedSend,
          reason: bannedSend ? "megagroup-send-banned" : "megagroup-participant"
        };
      }
      if (/Admin/i.test(cls)) {
        return {
          writable: !!participant?.adminRights?.postMessages,
          reason: participant?.adminRights?.postMessages
            ? "participant-admin-can-post"
            : "participant-admin-no-post-right"
        };
      }
      return { writable: false, reason: `participant-class-${cls || "unknown"}` };
    } catch (error) {
      const raw = String(error?.errorMessage || error?.message || error || "").toUpperCase();
      if (
        raw.includes("CHAT_WRITE_FORBIDDEN") ||
        raw.includes("USER_NOT_PARTICIPANT") ||
        raw.includes("CHANNEL_PRIVATE") ||
        raw.includes("CHAT_ADMIN_REQUIRED")
      ) {
        return { writable: false, reason: raw };
      }
      return fallback;
    }
  }

  return {
    checkDestinationWriteAccess,
    createDestinationChannel,
    createClient,
    extractChannelHandle,
    extractInviteHash,
    extractUsernameFromUrl,
    resolvePeer,
    sanitizeChannelHandle,
    usernameFromInput
  };
}

module.exports = {
  createTelegramClientService
};
