(() => {
  "use strict";

  const STORAGE_PREFIX = "volboost:";
  const DEFAULT_GAIN = 1.5; // meaningful default boost — users expect a booster to boost

  let audioCtx = null;
  let currentGain = DEFAULT_GAIN;
  const rigged = new WeakSet();  // elements with a live gain node
  const watched = new WeakSet(); // elements with a "play" listener already attached
  const gainNodes = new Set();

  const TAB_ID_KEY = "__volboost_tabid";
  let tabId = null;
  function getTabId() {
    if (tabId) return tabId;
    try { tabId = sessionStorage.getItem(TAB_ID_KEY); } catch (_) {}
    if (!tabId) {
      try { tabId = crypto.randomUUID(); } catch (_) { tabId = Date.now().toString(36) + Math.random().toString(36).slice(2); }
      try { sessionStorage.setItem(TAB_ID_KEY, tabId); } catch (_) {}
    }
    return tabId;
  }

  function storageKey() {
    return STORAGE_PREFIX + getTabId();
  }

  function ensureContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function rig(el) {
    if (rigged.has(el)) return;
    try {
      const ctx = ensureContext();
      // Works on DRM content too: EME protects decode, not the decoded
      // output, so this taps fine — but only if rigged lazily (on "play"),
      // not eagerly at page load, or it can break audio silently.
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = currentGain;
      source.connect(gain).connect(ctx.destination);
      gainNodes.add(gain);
      rigged.add(el);
    } catch (err) {
      console.warn("[Volume Booster] Failed to rig element:", el, err);
    }
  }

  /** Rig immediately if already playing; otherwise wait for its own "play". */
  function watch(el) {
    if (rigged.has(el) || watched.has(el)) return;
    watched.add(el);

    if (!el.paused) {
      rig(el);
    } else {
      el.addEventListener("play", () => rig(el), { once: true });
    }
  }

  function applyGain(value) {
    currentGain = value;
    gainNodes.forEach((node) => {
      const ctx = node.context;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      node.gain.setTargetAtTime(currentGain, ctx.currentTime, 0.01);
    });
  }

  /** Recursively discover audio/video elements, including inside shadow roots. */
  function scan(node) {
    if (!node || node.nodeType !== 1) return;

    if (node.matches?.("audio, video")) watch(node);

    if (node.shadowRoot) {
      for (const el of node.shadowRoot.querySelectorAll("audio, video")) watch(el);
      for (const child of node.shadowRoot.children) scan(child);
    }

    for (const child of node.childNodes) scan(child);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) scan(node);
    }
  });

  function loadStoredGain() {
    chrome.storage.local.get([storageKey()], (res) => {
      const stored = res[storageKey()];
      currentGain = typeof stored === "number" ? stored : DEFAULT_GAIN;
      if (typeof stored !== "number") {
        chrome.storage.local.set({ [storageKey()]: currentGain });
      }
      // Applies to anything that started playing (and got rigged at the
      // default gain) before this resolved.
      applyGain(currentGain);
    });
  }

  function start() {
    const root = document.documentElement || document;

    loadStoredGain(); // async — updates currentGain, then applies it
    scan(root); // discover existing media; wires "play" listeners lazily

    observer.observe(root, { childList: true, subtree: true });

    // Fallback for light-DOM elements the scan/observer might have missed.
    // No-op for anything already watched via scan().
    document.addEventListener(
      "play",
      (e) => {
        if (e.target instanceof HTMLMediaElement) rig(e.target);
      },
      true,
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "SET_VOLUME") {
      ensureContext();
      applyGain(msg.value);
      chrome.storage.local.set({ [storageKey()]: msg.value });
      sendResponse({ ok: true });
    } else if (msg?.type === "GET_VOLUME") {
      sendResponse({ value: currentGain });
    }
    return true;
  });
})();
