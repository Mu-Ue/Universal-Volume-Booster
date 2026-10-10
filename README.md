# Volume Booster

Boost any tab's audio up to **500%**, including DRM-protected streams. Manifest V3, works in Chrome and Firefox.

## Features

- **0–500% per tab**, shown as a percentage and in dB. A badge on the toolbar icon shows the current level.
- **Works with DRM content.** EME protects decryption, not the decoded audio, so MSE/EME players (blob: URLs) route through Web Audio normally.
- **No limiter or compression.** Audio is amplified exactly as set, so you are in full control: if it distorts, turn it down.
- **Keyboard shortcuts:** `Alt+Shift+Up` / `Alt+Shift+Down` (±25%), `Alt+Shift+V` opens the popup.
- **Scoped to the site:** a boost survives reloads and navigation within the same site, but resets when the tab moves to a different origin, so a 500% boost doesn't follow you onto a loud page.
- Reaches media inside open and **closed** shadow roots and inside iframes.
- Light and dark themes, keyboard and screen-reader accessible, clickable preset labels, mouse-wheel control.

## Architecture

```
popup / shortcuts ──write──► storage.session ──onChanged──► background ──push──► content script (every frame)
                                                                 └──► toolbar badge
```

| Part | Responsibility |
| --- | --- |
| `src/background` | Single source of truth. Stateless service worker: fans out storage changes to tabs and updates badges. |
| `src/content/engine.ts` | `BoostEngine`: a shared `MediaElementSource → Gain → destination` graph per frame. |
| `src/content/index.ts` | Messaging, lazy sync, and adopting the engine after an extension update. |
| `src/popup` | Framework-free UI (about 4 KB). |
| `src/shared` | Gain math, the message protocol, and the storage schema. |

One build serves both browsers. Where Chrome and Firefox differ, the manifest carries both keys, and each browser ignores the one it doesn't support: `background.service_worker` vs `background.scripts`, and `match_origin_as_fallback` vs `match_about_blank`.

### Design decisions

- **Zero-touch at 100%.** `createMediaElementSource` can't be undone, so the engine stays fully dormant (no AudioContext, observers or listeners) until a non-unity gain is requested.
- **Lazy capture on `play`.** This avoids the autoplay-policy trap where a suspended AudioContext silently mutes media. If the context is suspended anyway, it resumes on the next user gesture.
- **Never makes things worse.** Cross-origin media without CORS would be *silenced* by Web Audio, so it is detected and skipped.
- **Minimal traffic.** Only the top frame syncs on load. Sub-frames (ads, trackers) sync only if they ever play media.
- **Back/forward-cache aware.** A page restored with Back/Forward re-syncs every frame, so it never keeps a boost that was reset while it was cached.
- **No storage leaks.** Per-tab state lives in `storage.session` and is cleared when the tab closes. v1's leaked `storage.local` keys are purged on update.
- **Why not `tabCapture`?** DRM content captures as silence, it needs a user gesture every time, it adds latency, and it shows a recording indicator.

### Security

- Permissions: `storage` and `scripting` only, plus host access, which is required to reach page audio.
- Every cross-context message is validated against a typed schema and sender-checked. Gain is clamped and NaN-safe.
- Strict extension CSP, no `innerHTML`, no remote code, no `web_accessible_resources`. Runs only in the isolated world.

## Development

Requires Node 20.12+.

```sh
npm install
npm run build      # → dist/extension
npm run dev        # same, but rebuilds on change
npm run typecheck
```

Chrome: `chrome://extensions` → *Load unpacked* → `dist/extension`.
Firefox: `about:debugging` → *Load Temporary Add-on* → `dist/extension/manifest.json`.

## Limitations

- Media that is never attached to the DOM (`new Audio().play()`) can't be seen from an isolated content script.
- Media that the page already routes through its own Web Audio graph can't be captured a second time.
- Browsers don't allow extensions on internal pages (`chrome://`, the Web Store).

## License

MIT
