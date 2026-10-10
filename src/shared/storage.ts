/**
 * Persistence layer. Only trusted extension contexts (background, popup) touch
 * storage; content scripts receive state from the background over messaging.
 *
 *  - `storage.session` → per-tab state (`tab:<id>`). Kept in memory by the
 *    browser and wiped on restart, so nothing accumulates on disk.
 *  - `storage.local`   → user preferences that should survive restarts.
 */
import { clampGain, GAIN_DEFAULT } from "./gain";

export interface TabState {
  readonly gain: number;
  /** Top-level origin the gain was set on; navigating elsewhere resets it. */
  readonly origin: string | null;
  /** Which UI made the change, so the popup can ignore its own echoes. */
  readonly source: "popup" | "command";
}

export interface Settings {
  readonly limiter: boolean;
}

export const DEFAULT_SETTINGS: Settings = { limiter: true };

const TAB_KEY_PREFIX = "tab:";
const SETTINGS_KEY = "settings";
/** Keys written by v1, which leaked one entry per tab into storage.local. */
const LEGACY_KEY_PREFIX = "volboost:";

export function tabKey(tabId: number): string {
  return `${TAB_KEY_PREFIX}${tabId}`;
}

export function parseTabKey(key: string): number | null {
  if (!key.startsWith(TAB_KEY_PREFIX)) return null;
  const id = Number(key.slice(TAB_KEY_PREFIX.length));
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

export function parseTabState(value: unknown): TabState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  return {
    gain: clampGain(v.gain),
    origin: typeof v.origin === "string" ? v.origin : null,
    source: v.source === "command" ? "command" : "popup",
  };
}

export function parseSettings(value: unknown): Settings {
  if (typeof value !== "object" || value === null) return DEFAULT_SETTINGS;
  const v = value as Record<string, unknown>;
  return {
    limiter: typeof v.limiter === "boolean" ? v.limiter : DEFAULT_SETTINGS.limiter,
  };
}

/**
 * Origin used to scope a tab's boost. Only real web origins count; anything
 * else (file:, data:, opaque) yields null and disables origin scoping.
 */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export async function getTabState(tabId: number): Promise<TabState | null> {
  const key = tabKey(tabId);
  const res = await chrome.storage.session.get(key);
  return parseTabState(res[key]);
}

export async function setTabState(tabId: number, state: TabState): Promise<void> {
  const normalized: TabState = { ...state, gain: clampGain(state.gain) };
  await chrome.storage.session.set({ [tabKey(tabId)]: normalized });
}

export const DEFAULT_TAB_STATE: TabState = {
  gain: GAIN_DEFAULT,
  origin: null,
  source: "popup",
};

export async function clearTabState(tabId: number): Promise<void> {
  await chrome.storage.session.remove(tabKey(tabId));
}

/** Every tab with stored state. */
export async function getAllTabStates(): Promise<Map<number, TabState>> {
  const all = await chrome.storage.session.get(null);
  const out = new Map<number, TabState>();
  for (const [key, value] of Object.entries(all)) {
    const id = parseTabKey(key);
    const state = parseTabState(value);
    if (id !== null && state) out.set(id, state);
  }
  return out;
}

export async function getSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  return parseSettings(res[SETTINGS_KEY]);
}

export async function setSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: parseSettings(settings) });
}

export function isSettingsKey(key: string): boolean {
  return key === SETTINGS_KEY;
}

/** Remove per-tab keys left in storage.local by v1. */
export async function purgeLegacyStorage(): Promise<number> {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith(LEGACY_KEY_PREFIX));
  if (stale.length) await chrome.storage.local.remove(stale);
  return stale.length;
}
