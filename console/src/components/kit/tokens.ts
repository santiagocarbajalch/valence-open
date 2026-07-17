// Token access for TSX — the ONLY way components reference color.
// Values are CSS custom-property references, never literal hexes, so the
// palette lives in exactly one place (globals.css).

export type Tone = "ok" | "warn" | "bad" | "info" | "dim";

/** Accent value per tone — for dots, borders, fills. */
export const TONE: Record<Tone, string> = {
  ok: "var(--tone-ok)",
  warn: "var(--tone-warn)",
  bad: "var(--tone-bad)",
  info: "var(--tone-info)",
  dim: "var(--tone-neutral)",
};

/** Text-safe (AA on the dark field) value per tone — for colored text. */
export const TONE_INK: Record<Tone, string> = {
  ok: "var(--tone-ok-ink)",
  warn: "var(--tone-warn-ink)",
  bad: "var(--tone-bad-ink)",
  info: "var(--tone-info-ink)",
  dim: "var(--tone-neutral-ink)",
};

/**
 * Translucent mix of any color (token var or agent identity hex from data).
 * Replaces the `${hex}55` string-concat idiom, which breaks on var() values.
 */
export function toneMix(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/**
 * Resolve a CSS custom property to its computed value — for canvas drawing,
 * which can't consume var() strings. Client-side only.
 */
export function cssToken(name: string, fallback = ""): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
