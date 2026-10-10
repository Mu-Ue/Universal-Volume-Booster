/**
 * Typed message protocol between the background worker and content scripts.
 *
 * Every inbound message is treated as untrusted and validated with the guards
 * below before use. Messages are namespaced with a `vb/` prefix.
 */
import { GAIN_MAX, GAIN_MIN } from "./gain";

/** The full set of parameters the audio engine needs. */
export interface BoostSettings {
  /** Linear gain, 0–5. */
  readonly gain: number;
}

/** Background → content: apply these settings in every frame of the tab. */
export interface ApplyMessage {
  readonly type: "vb/apply";
  readonly settings: BoostSettings;
}

/** Popup → content (top frame): is a content script alive in this tab? */
export interface PingMessage {
  readonly type: "vb/ping";
}

/** Content → background: what settings should this tab use? */
export interface SyncMessage {
  readonly type: "vb/sync";
  /** Set after a back/forward-cache restore: re-push state to every frame. */
  readonly restored?: boolean;
}

export type ContentMessage = ApplyMessage | PingMessage;
export type BackgroundMessage = SyncMessage;

/** Reply to `vb/ping` and `vb/apply` from a content script. */
export interface ContentStatus {
  readonly ok: true;
  /** Media elements currently routed through the gain stage in this frame. */
  readonly boosted: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isBoostSettings(value: unknown): value is BoostSettings {
  return (
    isRecord(value) &&
    typeof value.gain === "number" &&
    Number.isFinite(value.gain) &&
    value.gain >= GAIN_MIN &&
    value.gain <= GAIN_MAX
  );
}

export function isContentMessage(value: unknown): value is ContentMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "vb/apply":
      return isBoostSettings(value.settings);
    case "vb/ping":
      return true;
    default:
      return false;
  }
}

export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  return (
    isRecord(value) &&
    value.type === "vb/sync" &&
    (value.restored === undefined || typeof value.restored === "boolean")
  );
}

export function isContentStatus(value: unknown): value is ContentStatus {
  return isRecord(value) && value.ok === true && typeof value.boosted === "number";
}
