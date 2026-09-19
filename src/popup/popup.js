const valueEl = document.getElementById("value");
const slider = document.getElementById("slider");

let activeTabId = null;
let firstRenderDone = false;

function getVolumeColor(vol) {
  if (vol === 0) return "#6b7280";
  if (vol > 200) return "#fb5c46";
  if (vol > 100) return "#fbbf24";
  return "#34d399";
}

function render(volume) {
  const clamped = Math.max(0, Math.min(300, volume));
  slider.value = clamped;
  valueEl.textContent = Math.round(clamped);

  const color = getVolumeColor(clamped);
  const pct = (clamped / 300) * 100;

  document.documentElement.style.setProperty("--accent", color);
  document.documentElement.style.setProperty("--pct", pct);

  // Only reveal the body on first render (startup).
  if (!firstRenderDone) {
    firstRenderDone = true;
    // First RAF: ensure the correct-color frame is painted.
    requestAnimationFrame(() => {
      // Second RAF: allow transitions to work normally after revealing.
      requestAnimationFrame(() => {
        document.body.style.display = "block";
      });
    });
  }
}

function sendVolume(volume) {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { type: "SET_VOLUME", value: volume / 100 }, () => {
    // No content script on this tab (chrome:// page, extension just
    // reloaded, etc.) — nothing to do, just avoid an uncaught error.
    void chrome.runtime.lastError;
  });
}

function checkBoostingStatus() {
  if (activeTabId == null) {
    render(100);
    return;
  }

  chrome.tabs.sendMessage(activeTabId, { type: "GET_VOLUME" }, (res) => {
    const ok = !chrome.runtime.lastError && res;
    render(ok && res.value != null ? res.value * 100 : 100);
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs?.[0];
  if (!tab) {
    render(100);
    return;
  }

  activeTabId = tab.id;
  checkBoostingStatus();
});

slider.addEventListener("input", () => {
  const volume = Number(slider.value);
  render(volume);
  sendVolume(volume);
});
