"use strict";

const fs = require("fs");

const COMPOSE_BASE_URL = "https://x.com/compose/post";
const LOGIN_URL = "https://x.com/i/flow/login";
const HOME_URL = "https://x.com/home";

function createXWebClientService(options = {}) {
  const profileDir = String(options.profileDir || "").trim();
  const headless = !!options.headless;
  const browserChannel = String(options.browserChannel || "chrome").trim().toLowerCase();
  const stealth = options.stealth !== false;
  const navigationTimeoutMs = Number(options.navigationTimeoutMs || 60000);
  const postTimeoutMs = Number(options.postTimeoutMs || 120000);
  const loginWaitMs = Number(options.loginWaitMs || 300000);
  const input = options.input;
  const infoTag = String(options.infoTag || "[UL-INFO]").trim() || "[UL-INFO]";

  if (!profileDir) {
    throw new Error("createXWebClientService: profileDir is required");
  }

  function logInfo(text) {
    console.log(`${infoTag} ${String(text || "").trim()}`.trim());
  }

  function loadPlaywright() {
    try {
      return require("playwright");
    } catch {
      throw new Error(
        "Missing dependency: playwright. Run `npm install` and ensure Playwright browsers are installed."
      );
    }
  }

  function launchArgs() {
    if (!stealth) return [];
    return [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-default-browser-check",
      "--disable-dev-shm-usage"
    ];
  }

  async function applyStealth(context) {
    if (!stealth) return;
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined
        });
      } catch {
        // ignore
      }
    });
  }

  async function locateCreateTweetResponse(page) {
    const response = await page.waitForResponse(
      (res) => {
        const url = String(res.url() || "");
        return res.request().method() === "POST" && url.includes("CreateTweet");
      },
      { timeout: postTimeoutMs }
    );
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    const tweetId =
      String(json?.data?.create_tweet?.tweet_results?.result?.rest_id || "").trim() ||
      String(json?.data?.create_tweet?.tweet_results?.result?.legacy?.id_str || "").trim();
    if (!tweetId) {
      throw new Error("Could not read tweet ID from X create tweet response.");
    }
    return tweetId;
  }

  async function resolveFileInput(page) {
    const selectors = [
      "input[data-testid='fileInput']",
      "input[type='file'][accept*='image']",
      "input[type='file'][accept*='video']",
      "input[type='file']"
    ];
    for (const selector of selectors) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      if (count > 0) {
        return loc.first();
      }
    }
    return null;
  }

  async function resolvePostButton(page) {
    const tweetButtonSelectors = [
      "button[data-testid='tweetButton']",
      "button[data-testid='tweetButtonInline']"
    ];
    for (const selector of tweetButtonSelectors) {
      const candidate = page.locator(selector).first();
      const visible = await candidate.isVisible({ timeout: 3000 }).catch(() => false);
      if (visible) return candidate;
    }
    return null;
  }

  async function waitForMediaAttached(page) {
    const previewSelectors = [
      "div[data-testid='attachments'] img",
      "div[data-testid='attachments'] video",
      "div[data-testid='tweetPhoto'] img",
      "div[data-testid='videoPlayer'] video"
    ];
    const startedAt = Date.now();
    while (Date.now() - startedAt < postTimeoutMs) {
      let hasPreview = false;
      for (const selector of previewSelectors) {
        const visible = await page
          .locator(selector)
          .first()
          .isVisible({ timeout: 1000 })
          .catch(() => false);
        if (visible) {
          hasPreview = true;
          break;
        }
      }
      const postButton = await resolvePostButton(page);
      const postEnabled = postButton
        ? ((await postButton.isEnabled().catch(() => false)) &&
          (await postButton.getAttribute("aria-disabled").catch(() => "false")) !== "true")
        : false;
      if (hasPreview && postEnabled) {
        return true;
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  async function resolveComposerEditor(page, timeoutMs = 5000) {
    const selectors = [
      "div[data-testid='tweetTextarea_0']",
      "div[data-testid='tweetTextarea_0'] div[role='textbox']",
      "div[role='textbox'][contenteditable='true']",
      "div[contenteditable='true'][data-testid='tweetTextarea_0']"
    ];
    for (const selector of selectors) {
      const loc = page.locator(selector).first();
      const visible = await loc.isVisible({ timeout: timeoutMs }).catch(() => false);
      if (visible) {
        return loc;
      }
    }
    return null;
  }

  async function isEditorVisible(page, timeoutMs = 5000) {
    const editor = await resolveComposerEditor(page, timeoutMs);
    return !!editor;
  }

  async function openComposerFromHome(page) {
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });

    const postButtonCandidates = [
      "a[data-testid='SideNav_NewTweet_Button']",
      "button[data-testid='SideNav_NewTweet_Button']",
      "div[data-testid='SideNav_NewTweet_Button']",
      "button[data-testid='tweetButtonInline']",
      "a[href='/compose/post']",
      "button[aria-label='Post']"
    ];

    for (const selector of postButtonCandidates) {
      const button = page.locator(selector).first();
      const visible = await button.isVisible({ timeout: 3000 }).catch(() => false);
      if (!visible) continue;
      await button.click({ timeout: 5000 });
      if (await isEditorVisible(page, 8000)) {
        return true;
      }
    }

    // X often supports "n" shortcut from home to open composer.
    await page.keyboard.press("n").catch(() => {});
    if (await isEditorVisible(page, 8000)) {
      return true;
    }

    return false;
  }

  async function promptManualLogin(page) {
    if (headless) {
      throw new Error(
        "X Web session is not logged in. Run with X_WEB_HEADLESS=0 once, login in the opened browser, then rerun."
      );
    }
    logInfo(
      "x-web login required: in the opened browser, ensure you are fully logged in and at x.com/home."
    );
    if (input && typeof input.text === "function") {
      await input.text(
        `Press Enter after login is complete (timeout ${Math.ceil(loginWaitMs / 1000)}s): `
      );
    } else {
      await page.waitForTimeout(loginWaitMs);
    }
    await page.waitForTimeout(1500);
  }

  async function ensureComposerReady(page, options = {}) {
    const requiresReplyComposer = !!options.requiresReplyComposer;
    let editor = await resolveComposerEditor(page, 12000);
    if (editor) {
      return { editor, usedHomeFallback: false };
    }

    const attemptOpenComposer = async () => {
      if (!requiresReplyComposer) {
        const openedFromHome = await openComposerFromHome(page);
        if (openedFromHome) {
          editor = await resolveComposerEditor(page, 4000);
          if (editor) {
            return { ok: true, usedHomeFallback: true };
          }
        }
      }
      await page.goto(COMPOSE_BASE_URL, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs
      });
      editor = await resolveComposerEditor(page, 10000);
      if (editor) {
        return { ok: true, usedHomeFallback: false };
      }
      return { ok: false, usedHomeFallback: false };
    };

    let attempt = await attemptOpenComposer();
    if (attempt.ok) {
      return { editor, usedHomeFallback: attempt.usedHomeFallback };
    }

    await promptManualLogin(page);
    attempt = await attemptOpenComposer();
    if (attempt.ok) {
      return { editor: editor || page.locator("div[data-testid='tweetTextarea_0']").first(), usedHomeFallback: attempt.usedHomeFallback };
    }

    throw new Error(
      `Could not access X compose page after login (current_url=${page.url()}). ` +
        "If login loops/refreshes, set X_WEB_BROWSER_CHANNEL=chrome and X_WEB_STEALTH=1, keep X_WEB_HEADLESS=0, and login manually on x.com/home before pressing Enter."
    );
  }

  async function openReplyComposer(page, replyToId) {
    const safeReplyToId = String(replyToId || "").trim();
    if (!safeReplyToId) return false;

    await page.goto(`https://x.com/i/status/${encodeURIComponent(safeReplyToId)}`, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeoutMs
    });
    const replySelectors = [
      "button[data-testid='reply']",
      "div[data-testid='reply']",
      "a[href$='/reply']"
    ];
    for (const selector of replySelectors) {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 4000 }).catch(() => false);
      if (!visible) continue;
      await btn.click({ timeout: 6000 });
      if (await isEditorVisible(page, 10000)) return true;
    }
    return false;
  }

  async function createClient() {
    const { chromium } = loadPlaywright();
    fs.mkdirSync(profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(profileDir, {
      channel: browserChannel || "chrome",
      headless,
      viewport: { width: 1366, height: 900 },
      args: launchArgs(),
      ignoreDefaultArgs: stealth ? ["--enable-automation"] : undefined
    });
    await applyStealth(context);
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(navigationTimeoutMs);

    const close = async () => {
      try {
        await context.close();
      } catch {
        // ignore close errors
      }
    };

    const sendPost = async ({ text, mediaPath, mediaPaths, replyToId }) => {
      const safeReplyToId = String(replyToId || "").trim();
      if (safeReplyToId) {
        const openedReply = await openReplyComposer(page, safeReplyToId);
        if (!openedReply) {
          const composeUrl = `${COMPOSE_BASE_URL}?in_reply_to=${encodeURIComponent(safeReplyToId)}`;
          await page.goto(composeUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
        }
      }
      const composer = await ensureComposerReady(page, { requiresReplyComposer: !!safeReplyToId });
      if (composer.usedHomeFallback && String(replyToId || "").trim()) {
        throw new Error("Could not open reply composer for x-web thread post.");
      }
      const editor = composer.editor;

      await editor.click({ timeout: 10000 });
      const safeText = String(text || "");
      if (safeText) {
        await page.keyboard.insertText(safeText);
      }

      const mediaList = [];
      const singleMediaPath = String(mediaPath || "").trim();
      if (singleMediaPath) {
        mediaList.push(singleMediaPath);
      }
      if (Array.isArray(mediaPaths)) {
        for (const candidate of mediaPaths) {
          const pathText = String(candidate || "").trim();
          if (!pathText) continue;
          mediaList.push(pathText);
        }
      }
      const uniqueMediaList = Array.from(new Set(mediaList));

      if (uniqueMediaList.length > 0) {
        const fileInput = await resolveFileInput(page);
        if (!fileInput) {
          throw new Error(`Could not find media file input (current_url=${page.url()}).`);
        }
        await fileInput.setInputFiles(uniqueMediaList, { timeout: postTimeoutMs });
        const attached = await waitForMediaAttached(page);
        if (!attached) {
          throw new Error(`Media upload did not complete (current_url=${page.url()}).`);
        }
      }

      const tweetButton = await resolvePostButton(page);
      if (!tweetButton) {
        throw new Error(`Could not find X post button (current_url=${page.url()}).`);
      }
      await tweetButton.waitFor({ state: "visible", timeout: postTimeoutMs });
      const createTweetResponse = locateCreateTweetResponse(page);
      await tweetButton.click({ timeout: postTimeoutMs });
      return await createTweetResponse;
    };

    return {
      close,
      sendPost
    };
  }

  return {
    createClient
  };
}

module.exports = {
  createXWebClientService
};
