/**
 * Popup UI. Reads and writes state through storage only; the background
 * worker fans changes out to the tab. The popup's single privileged action is
 * injecting the content script into tabs that were open before the extension
 * was installed (or requesting host access on Firefox).
 */
import {
  formatDecibels,
  gainToPercent,
  GAIN_MAX,
  levelOf,
  percentToGain,
} from "../shared/gain";
import { isContentStatus } from "../shared/messages";
import { getTabState, originOf, parseTabKey, parseTabState, setTabState } from "../shared/storage";

function $<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} missing from popup.html`);
  return el;
}

const card = $("card", HTMLElement);
const controls = $("controls", HTMLElement);
const slider = $("slider", HTMLInputElement);
const valueEl = $("value", HTMLElement);
const dbEl = $("db", HTMLElement);
const notice = $("notice", HTMLElement);
const noticeText = $("notice-text", HTMLElement);
const noticeAction = $("notice-action", HTMLButtonElement);
const chips = [...document.querySelectorAll<HTMLButtonElement>(".chip[data-percent]")];

const ALL_SITES = ["<all_urls>"];
const WHEEL_STEP_PERCENT = 5;

// ── Rendering ────────────────────────────────────────────────────────────

function render(gain: number): void {
  const percent = gainToPercent(gain);
  card.dataset.level = levelOf(gain);
  slider.value = String(percent);
  slider.style.setProperty("--pct", `${(percent / (GAIN_MAX * 100)) * 100}%`);
  slider.setAttribute("aria-valuetext", `${percent} percent, ${formatDecibels(gain)}`);
  valueEl.textContent = String(percent);
  dbEl.textContent = formatDecibels(gain);
  for (const chip of chips) {
    chip.setAttribute("aria-pressed", String(Number(chip.dataset.percent) === percent));
  }
}

function reveal(): void {
  document.body.classList.add("ready");
  // Enable transitions only after the first frame has painted.
  requestAnimationFrame(() => requestAnimationFrame(() => { document.body.classList.add("animated"); }));
}

function showNotice(text: string, action?: { label: string; run: () => void }): void {
  controls.setAttribute("aria-disabled", "true");
  slider.disabled = true;
  noticeText.textContent = text;
  notice.hidden = false;
  noticeAction.hidden = !action;
  if (action) {
    noticeAction.textContent = action.label;
    noticeAction.onclick = action.run;
  }
}

function hideNotice(): void {
  controls.removeAttribute("aria-disabled");
  slider.disabled = false;
  notice.hidden = true;
}

// ── Content script availability ──────────────────────────────────────────

type Availability = "ready" | "needs-permission" | "restricted";

async function ensureContentScript(tabId: number): Promise<Availability> {
  try {
    const reply: unknown = await chrome.tabs.sendMessage(tabId, { type: "vb/ping" }, { frameId: 0 });
    if (isContentStatus(reply)) return "ready";
  } catch {
    // No listener — the tab predates the install, or we can't run here.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    return "ready";
  } catch {
    const granted = await chrome.permissions.contains({ origins: ALL_SITES }).catch(() => true);
    return granted ? "restricted" : "needs-permission";
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const state = tab?.id !== undefined ? await getTabState(tab.id) : null;

  const origin = originOf(tab?.url);
  // A boost set on another site no longer applies (the background resets it
  // as soon as the new page loads), so don't display it either.
  const stale = Boolean(state?.origin && origin && state.origin !== origin);
  render(state && !stale ? state.gain : 1);
  reveal();

  if (tab?.id === undefined) {
    showNotice("No active tab.");
    return;
  }
  const tabId = tab.id;

  const check = async (): Promise<void> => {
    const availability = await ensureContentScript(tabId);
    if (availability === "ready") hideNotice();
    else if (availability === "restricted")
      showNotice("The browser doesn't allow extensions on this page.");
    else
      showNotice("Volume Booster needs access to websites to adjust their audio.", {
        label: "Allow access",
        // Must call permissions.request synchronously inside the click.
        run: () => {
          void chrome.permissions.request({ origins: ALL_SITES }).then(async (ok) => {
            if (ok) await check();
          });
        },
      });
  };
  void check();

  // Coalesce slider input to at most one storage write per animation frame.
  let pendingGain: number | null = null;
  const commit = (gain: number): void => {
    render(gain);
    if (pendingGain === null) {
      requestAnimationFrame(() => {
        const g = pendingGain;
        pendingGain = null;
        if (g !== null) void setTabState(tabId, { gain: g, origin, source: "popup" });
      });
    }
    pendingGain = gain;
  };

  slider.addEventListener("input", () => { commit(percentToGain(Number(slider.value))); });

  // Mouse wheel anywhere on the slider area nudges the volume.
  slider.parentElement?.addEventListener(
    "wheel",
    (e) => {
      if (slider.disabled) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? WHEEL_STEP_PERCENT : -WHEEL_STEP_PERCENT;
      commit(percentToGain(Number(slider.value) + delta));
    },
    { passive: false },
  );

  for (const chip of chips) {
    chip.addEventListener("click", () => { commit(percentToGain(Number(chip.dataset.percent))); });
  }

  // Reflect changes made elsewhere (keyboard shortcuts, site navigation)
  // while the popup is open, but ignore echoes of our own writes.
  chrome.storage.session.onChanged.addListener((changes) => {
    for (const [key, change] of Object.entries(changes)) {
      if (parseTabKey(key) !== tabId) continue;
      const next = parseTabState(change.newValue);
      if (next?.source === "popup") continue;
      render(next?.gain ?? 1);
    }
  });
}

init().catch((err: unknown) => {
  console.error("[Volume Booster]", err);
  render(1);
  reveal();
  showNotice("Something went wrong. Try reopening the popup.");
});
