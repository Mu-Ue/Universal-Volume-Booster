/**
 * BoostEngine — routes a frame's media elements through a shared Web Audio
 * gain stage.
 *
 *   <video>/<audio> ─► MediaElementSource ─┐
 *   <video>/<audio> ─► MediaElementSource ─┼─► GainNode ─► [Limiter] ─► destination
 *   <video>/<audio> ─► MediaElementSource ─┘
 *
 * Design rules:
 *  1. **Zero-touch at 100 %.** `createMediaElementSource` permanently hijacks
 *     an element's output and cannot be undone, so nothing is rerouted until
 *     the user actually asks for a non-unity gain. Until then the engine is
 *     dormant: no observers, no listeners, no AudioContext.
 *  2. **Lazy rigging.** Elements are captured when they start playing, not
 *     when they appear. Capturing at page load runs into autoplay policy (a
 *     suspended AudioContext silences the element) and wastes work on media
 *     that never plays.
 *  3. **Never make things worse.** Media whose samples Web Audio cannot read
 *     (cross-origin without CORS) is skipped, since rerouting it would mute it.
 */
import { GAIN_DEFAULT } from "../shared/gain";
import type { BoostSettings } from "../shared/messages";

export interface EngineOptions {
  readonly document: Document;
  /** Origin of this frame, used for CORS-taint detection. */
  readonly origin: string;
  /** Resolve open *and closed* shadow roots where the browser allows it. */
  readonly getShadowRoot?: (el: Element) => ShadowRoot | null;
}

/**
 * Web Audio refuses to expose samples from cross-origin media that was not
 * fetched with CORS: a MediaElementAudioSourceNode on such an element outputs
 * pure silence. MSE/EME players (YouTube, Netflix, Spotify, …) use same-origin
 * `blob:` URLs and are unaffected, which is why boosting works for DRM content.
 */
function isLikelyTainted(el: HTMLMediaElement, pageOrigin: string): boolean {
  // MediaStreams (WebRTC, getUserMedia) are not subject to CORS tainting.
  if (el.srcObject) return false;
  // A CORS-mode request that loaded at all is untainted.
  if (el.hasAttribute("crossorigin")) return false;
  // Once resource selection has run, currentSrc is the one that is playing.
  const urls = el.currentSrc
    ? [el.currentSrc]
    : [el.getAttribute("src") !== null ? el.src : "", ...[...el.querySelectorAll("source")].map((s) => s.src)];
  return urls.some((url) => {
    try {
      const u = new URL(url);
      return (u.protocol === "http:" || u.protocol === "https:") && u.origin !== pageOrigin;
    } catch {
      return false;
    }
  });
}

function warn(message: string, ...details: unknown[]): void {
  console.debug(`[Volume Booster] ${message}`, ...details);
}

export interface EngineStats {
  readonly boosted: number;
}

/** Smoothing time constant for gain changes; avoids zipper noise. */
const GAIN_RAMP_SECONDS = 0.015;
const GESTURE_EVENTS = ["pointerdown", "keydown", "touchend"] as const;

export class BoostEngine {
  readonly #doc: Document;
  readonly #origin: string;
  readonly #getShadowRoot: (el: Element) => ShadowRoot | null;

  #settings: BoostSettings = { gain: GAIN_DEFAULT, limiter: true };
  #active = false;

  #ctx: AudioContext | null = null;
  #input: GainNode | null = null;
  #limiter: DynamicsCompressorNode | null = null;

  /** Elements we have attempted to capture (successfully or not). */
  readonly #handled = new WeakSet<HTMLMediaElement>();
  readonly #roots = new WeakSet<Document | ShadowRoot>();
  #boosted = 0;
  #observer: MutationObserver | null = null;
  #awaitingGesture = false;

  constructor(options: EngineOptions) {
    this.#doc = options.document;
    this.#origin = options.origin;
    this.#getShadowRoot = options.getShadowRoot ?? ((el) => el.shadowRoot);
  }

  get settings(): BoostSettings {
    return this.#settings;
  }

  get active(): boolean {
    return this.#active;
  }

  stats(): EngineStats {
    return { boosted: this.#boosted };
  }

  update(next: BoostSettings): void {
    const prev = this.#settings;
    this.#settings = next;

    if (this.#ctx && this.#input) {
      this.#input.gain.setTargetAtTime(next.gain, this.#ctx.currentTime, GAIN_RAMP_SECONDS);
      if (prev.limiter !== next.limiter) this.#wire();
      this.#resume();
    }

    if (next.gain !== GAIN_DEFAULT) {
      if (!this.#active) this.#activate();
      // Crossing away from unity: pick up anything already playing.
      else if (prev.gain === GAIN_DEFAULT) this.#scan(this.#doc);
    }
  }

  /** Stop observing the page. Captured elements stay routed (unavoidable). */
  dispose(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#removeGestureListeners();
    this.#active = false;
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  #activate(): void {
    this.#active = true;
    this.#observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) this.#scan(node as Element);
        }
      }
    });
    this.#watchRoot(this.#doc);
    this.#scan(this.#doc);
  }

  /**
   * `play` doesn't bubble and isn't composed, so one capturing listener per
   * tree (document + every shadow root) is enough to see every element start.
   */
  #watchRoot(root: Document | ShadowRoot): void {
    if (this.#roots.has(root)) return;
    this.#roots.add(root);
    root.addEventListener("play", this.#onPlay, { capture: true, passive: true });
    this.#observer?.observe(root, { childList: true, subtree: true });
  }

  readonly #onPlay = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLMediaElement) this.#consider(target);
  };

  /** Walk a subtree with a native TreeWalker, descending into shadow roots. */
  #scan(root: Document | ShadowRoot | Element): void {
    const walker = this.#doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode();
    while (node) {
      const el = node as Element;
      if (el instanceof HTMLMediaElement) this.#consider(el);
      const shadow = this.#safeShadowRoot(el);
      if (shadow) {
        this.#watchRoot(shadow);
        this.#scan(shadow);
      }
      node = walker.nextNode();
    }
  }

  #safeShadowRoot(el: Element): ShadowRoot | null {
    try {
      const root = this.#getShadowRoot(el);
      return root && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? root : null;
    } catch {
      return null;
    }
  }

  // ── Capture ────────────────────────────────────────────────────────────

  #consider(el: HTMLMediaElement): void {
    if (this.#handled.has(el)) return;
    if (this.#settings.gain === GAIN_DEFAULT) return; // rule 1
    if (el.paused) return; // rule 2 — we'll see its `play` event later
    if (isLikelyTainted(el, this.#origin)) {
      // rule 3 — mark handled so we only warn once per element.
      this.#handled.add(el);
      warn("Skipping cross-origin media without CORS (would be silenced):", el);
      return;
    }
    this.#capture(el);
  }

  #capture(el: HTMLMediaElement): void {
    this.#handled.add(el);
    const input = this.#ensureGraph();
    if (!input || !this.#ctx) return;
    try {
      this.#ctx.createMediaElementSource(el).connect(input);
      this.#boosted++;
    } catch (err) {
      // Typically InvalidStateError: the page already owns a source node for
      // this element (its own Web Audio graph). Nothing we can safely do.
      warn("Could not capture media element:", el, err);
    }
  }

  // ── Audio graph ────────────────────────────────────────────────────────

  #ensureGraph(): GainNode | null {
    if (this.#input) {
      this.#resume();
      return this.#input;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch (err) {
      warn("Web Audio is unavailable in this frame:", err);
      return null;
    }

    const input = ctx.createGain();
    input.gain.value = this.#settings.gain;

    // Brick-wall-ish limiter: transparent below -1 dBFS, clamps peaks above.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;

    this.#ctx = ctx;
    this.#input = input;
    this.#limiter = limiter;
    this.#wire();
    this.#resume();
    return input;
  }

  #wire(): void {
    const ctx = this.#ctx;
    const input = this.#input;
    const limiter = this.#limiter;
    if (!ctx || !input || !limiter) return;
    input.disconnect();
    limiter.disconnect();
    if (this.#settings.limiter) {
      input.connect(limiter);
      limiter.connect(ctx.destination);
    } else {
      input.connect(ctx.destination);
    }
  }

  /**
   * A captured element is silent while its AudioContext is suspended. Try to
   * resume now; if autoplay policy blocks that, retry on the next user gesture.
   */
  #resume(): void {
    const ctx = this.#ctx;
    if (!ctx || ctx.state === "running") return;
    ctx.resume().then(
      () => {
        if (ctx.state === "running") this.#removeGestureListeners();
        else this.#addGestureListeners();
      },
      () => { this.#addGestureListeners(); },
    );
  }

  readonly #onGesture = (): void => {
    this.#resume();
  };

  #addGestureListeners(): void {
    if (this.#awaitingGesture) return;
    this.#awaitingGesture = true;
    const win = this.#doc.defaultView;
    for (const type of GESTURE_EVENTS) {
      win?.addEventListener(type, this.#onGesture, { capture: true, passive: true });
    }
  }

  #removeGestureListeners(): void {
    if (!this.#awaitingGesture) return;
    this.#awaitingGesture = false;
    const win = this.#doc.defaultView;
    for (const type of GESTURE_EVENTS) {
      win?.removeEventListener(type, this.#onGesture, { capture: true });
    }
  }
}
