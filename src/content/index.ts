/**
 * Content script entry. Runs in every frame (isolated world), but stays inert
 * until the tab is actually boosted:
 *
 *  - Top frame: asks the background for this tab's settings once on load, so
 *    a boost survives reloads and in-site navigation.
 *  - Sub-frames: ask lazily, on their first `play` event, so ad/tracker
 *    iframes that never play media cost one listener and nothing else.
 *  - Pages restored from the back/forward cache re-sync.
 *  - All frames: receive `vb/apply` pushes whenever settings change.
 */
import type { BoostSettings, ContentStatus, SyncMessage } from "../shared/messages";
import { isBoostSettings, isContentMessage } from "../shared/messages";
import { BoostEngine } from "./engine";

/**
 * Bump when BoostEngine's public surface changes. After an extension update
 * the orphaned old script can no longer talk to the extension, but if it
 * shares our isolated world we can adopt its engine (and the elements it has
 * already captured, which nobody else can capture again).
 */
const ENGINE_API_VERSION = 1;
const INSTANCE_KEY = "__volumeBooster__";

interface Instance {
  readonly apiVersion: number;
  readonly engine: BoostEngine;
  readonly isAlive: () => boolean;
}

type GlobalWithInstance = typeof globalThis & { [INSTANCE_KEY]?: Instance };

/**
 * The typings claim these namespaces always exist, but `chrome.runtime` goes
 * away in orphaned scripts after an extension update, and Firefox has no
 * `chrome.dom`.
 */
const maybeRuntime = (): typeof chrome.runtime | undefined => chrome.runtime;
const maybeDom = chrome.dom as typeof chrome.dom | undefined;

function runtimeAlive(): boolean {
  try {
    return Boolean(maybeRuntime()?.id);
  } catch {
    return false;
  }
}

function getShadowRoot(el: Element): ShadowRoot | null {
  // Firefox exposes closed roots to content scripts on the element itself…
  const ff = el as Element & { openOrClosedShadowRoot?: () => ShadowRoot | null };
  if (typeof ff.openOrClosedShadowRoot === "function") return ff.openOrClosedShadowRoot();
  // …Chromium through chrome.dom (HTML elements only).
  if (el instanceof HTMLElement && maybeDom) return maybeDom.openOrClosedShadowRoot(el);
  return el.shadowRoot;
}

function obtainEngine(scope: GlobalWithInstance): BoostEngine | null {
  const existing = scope[INSTANCE_KEY];
  if (existing?.isAlive()) return null; // a live copy is already running here

  let engine: BoostEngine;
  if (existing?.apiVersion === ENGINE_API_VERSION) {
    engine = existing.engine;
  } else {
    // Incompatible orphan: neutralise it so it doesn't keep a stale boost.
    try {
      existing?.engine.update({ gain: 1, limiter: false });
      existing?.engine.dispose();
    } catch {
      /* best effort */
    }
    engine = new BoostEngine({
      document,
      origin: self.origin,
      getShadowRoot,
    });
  }

  scope[INSTANCE_KEY] = { apiVersion: ENGINE_API_VERSION, engine, isAlive: runtimeAlive };
  return engine;
}

function main(engine: BoostEngine): void {
  const isTopFrame = window === window.top;
  let synced = false;
  let syncInFlight = false;
  /** Incremented on every push, so a slower pull can't overwrite newer state. */
  let applyCount = 0;

  const status = (): ContentStatus => ({ ok: true, ...engine.stats() });

  const apply = (settings: BoostSettings): void => {
    synced = true;
    engine.update(settings);
  };

  const sync = (restored = false): void => {
    if (synced || syncInFlight || !runtimeAlive()) return;
    syncInFlight = true;
    const seen = applyCount;
    const request: SyncMessage = restored ? { type: "vb/sync", restored } : { type: "vb/sync" };
    chrome.runtime
      .sendMessage(request)
      .then((reply: unknown) => {
        if (seen === applyCount && isBoostSettings(reply)) apply(reply);
      })
      .catch(() => {
        /* service worker unavailable (e.g. extension reloading) — retry later */
      })
      .finally(() => {
        syncInFlight = false;
      });
  };

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Only the extension itself can reach this listener, but verify anyway.
    if (sender.id !== chrome.runtime.id || !isContentMessage(message)) return false;
    if (message.type === "vb/apply") {
      applyCount++;
      apply(message.settings);
    }
    sendResponse(status());
    return false;
  });

  // Capturing listener: sees `play` from every light-DOM element in the frame.
  // It is the only trigger in sub-frames, and the retry path in the top frame.
  document.addEventListener("play", () => { sync(); }, { capture: true, passive: true });
  if (isTopFrame) sync();

  // Pages restored from the back/forward cache keep this script's state, but
  // the tab's state may have changed (e.g. reset by visiting another site).
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    synced = false;
    if (isTopFrame) sync(true);
  });
}

const engine = obtainEngine(globalThis);
if (engine) main(engine);
