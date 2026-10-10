/**
 * Background service worker (event page on Firefox). It is the single
 * authority over per-tab state:
 *
 *   popup / shortcuts ──write──► storage ──onChanged──► background ──push──► content (all frames)
 *                                                           └──► toolbar badge
 *
 * Because every writer goes through storage, the popup and the keyboard
 * shortcuts never have to coordinate with each other. The worker holds no
 * in-memory state, so it can be terminated at any time without losing data.
 */
import { BADGE_COLORS, badgeText, COMMAND_STEP, GAIN_DEFAULT, levelOf, stepGain } from "../shared/gain";
import type { BoostSettings, ContentMessage } from "../shared/messages";
import { isBackgroundMessage } from "../shared/messages";
import {
  clearTabState,
  DEFAULT_TAB_STATE,
  getAllTabStates,
  getSettings,
  getTabState,
  isSettingsKey,
  originOf,
  parseSettings,
  parseTabKey,
  parseTabState,
  purgeLegacyStorage,
  setTabState,
} from "../shared/storage";
import type { TabState } from "../shared/storage";

// ── Helpers ──────────────────────────────────────────────────────────────

async function sendToTab(tabId: number, message: ContentMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // No content script (restricted page, discarded tab) — nothing to update.
  }
}

async function pushSettings(tabId: number, settings: BoostSettings): Promise<void> {
  await sendToTab(tabId, { type: "vb/apply", settings });
}

async function updateBadge(tabId: number, gain: number): Promise<void> {
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: badgeText(gain) }),
      chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS[levelOf(gain)] }),
      chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" }),
    ]);
  } catch {
    // Tab closed between the event and the call.
  }
}

/**
 * Resolve the effective state for a tab whose top frame is at `url`. A boost
 * is scoped to the site it was set on: landing on a different origin in the
 * same tab resets it, so a 500 % boost meant for a quiet video doesn't follow
 * you onto the next page.
 */
async function resolveTabState(tabId: number, url: string | undefined): Promise<TabState> {
  const state = await getTabState(tabId);
  if (!state) return DEFAULT_TAB_STATE;
  const origin = originOf(url);
  if (state.origin && origin && state.origin !== origin) {
    await clearTabState(tabId);
    return DEFAULT_TAB_STATE;
  }
  return state;
}

// ── Content script sync ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isBackgroundMessage(message)) return false;
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return false;

  const isTopFrame = sender.frameId === 0;
  void (async () => {
    // Only the top frame's URL decides whether the tab moved to a new site.
    const state = isTopFrame
      ? await resolveTabState(tabId, sender.url ?? sender.tab?.url)
      : ((await getTabState(tabId)) ?? DEFAULT_TAB_STATE);
    const { limiter } = await getSettings();
    const settings: BoostSettings = { gain: state.gain, limiter };
    sendResponse(settings);
    if (!isTopFrame) return;
    await updateBadge(tabId, state.gain);
    // Sub-frames restored from the back/forward cache may hold stale state.
    if (message.restored) await pushSettings(tabId, settings);
  })();
  return true; // keep the channel open for the async reply
});

// ── State fan-out ────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  void (async () => {
    if (area === "session") {
      const { limiter } = await getSettings();
      for (const [key, change] of Object.entries(changes)) {
        const tabId = parseTabKey(key);
        if (tabId === null) continue;
        const gain = parseTabState(change.newValue)?.gain ?? GAIN_DEFAULT;
        await Promise.all([pushSettings(tabId, { gain, limiter }), updateBadge(tabId, gain)]);
      }
    } else if (area === "local") {
      const change = Object.entries(changes).find(([key]) => isSettingsKey(key))?.[1];
      if (!change) return;
      const { limiter } = parseSettings(change.newValue);
      const tabs = await getAllTabStates();
      await Promise.all([...tabs].map(([id, s]) => pushSettings(id, { gain: s.gain, limiter })));
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTabState(tabId);
});

// ── Keyboard shortcuts ───────────────────────────────────────────────────

async function adjustActiveTab(command: string, tab?: chrome.tabs.Tab): Promise<void> {
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target?.id === undefined) return;

  const current = await resolveTabState(target.id, target.url);
  let gain: number;
  switch (command) {
    case "volume-up":
      gain = stepGain(current.gain, COMMAND_STEP);
      break;
    case "volume-down":
      gain = stepGain(current.gain, -COMMAND_STEP);
      break;
    case "volume-reset":
      gain = GAIN_DEFAULT;
      break;
    default:
      return;
  }
  await setTabState(target.id, { gain, origin: originOf(target.url), source: "command" });
}

chrome.commands.onCommand.addListener((command, tab) => {
  void adjustActiveTab(command, tab);
});

// ── Lifecycle ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "update") void purgeLegacyStorage();
});
