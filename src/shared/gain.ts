/**
 * Pure gain math shared by every extension context. No browser APIs here, so
 * everything in this file is trivially unit-testable.
 */

/** Linear gain bounds. 0 = silence, 1 = unity (untouched), 5 = +14 dB. */
export const GAIN_MIN = 0;
export const GAIN_MAX = 5;
export const GAIN_DEFAULT = 1;

/**
 * Coerce untrusted input into a valid gain. Anything that is not a finite
 * number falls back to unity, so a corrupt value can never blast the user.
 */
export function clampGain(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return GAIN_DEFAULT;
  // Snap to whole percentages so floating-point noise (e.g. 2.3000000000000003)
  // never leaks into storage, comparisons or the UI.
  const snapped = Math.round(value * 100) / 100;
  return Math.min(GAIN_MAX, Math.max(GAIN_MIN, snapped));
}

export function gainToPercent(gain: number): number {
  return Math.round(clampGain(gain) * 100);
}

export function percentToGain(percent: number): number {
  return clampGain(percent / 100);
}

/** Linear gain → decibels relative to the original signal. */
export function gainToDecibels(gain: number): number {
  const g = clampGain(gain);
  return g === 0 ? -Infinity : 20 * Math.log10(g);
}

export function formatDecibels(gain: number): string {
  const db = gainToDecibels(gain);
  if (db === -Infinity) return "−∞ dB";
  const rounded = Math.round(db * 10) / 10;
  if (rounded === 0) return "0.0 dB";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(1)} dB`;
}

export type Level = "muted" | "normal" | "boost" | "high" | "higher" | "extreme";

/** Bucket a gain into a coarse "loudness" level used for colour coding. */
export function levelOf(gain: number): Level {
  const p = gainToPercent(gain);
  if (p === 0) return "muted";
  if (p <= 100) return "normal";
  if (p <= 200) return "boost";
  if (p <= 300) return "high";
  if (p <= 400) return "higher";
  return "extreme";
}

/** Toolbar badge text: the current volume in percent. */
export function badgeText(gain: number): string {
  return String(gainToPercent(gain));
}

export const BADGE_COLORS: Readonly<Record<Level, string>> = {
  muted: "#6b7280",
  normal: "#059669",
  boost: "#65a30d",
  high: "#ca8a04",
  higher: "#ea580c",
  extreme: "#dc2626",
};
