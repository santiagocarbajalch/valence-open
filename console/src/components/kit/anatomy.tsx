"use client";

// CALIBRATED INSTRUMENT anatomy — the shared primitives the surface phases
// (Today / Pipeline / Scraping) consume. COLOR = STATE: every carrier here
// rides one of the five state hues (owed / due / meet / ok / idle). The visual
// recipe lives in globals.css (.chip, .assay-strip, .pips, .hint, …); these
// components just wire the classes with an accessible, typed API.

import type { ReactNode } from "react";
import { cx } from "./core";

/** The five state hues — the ONLY colors on the board besides ink. */
export type StateHue = "owed" | "due" | "meet" | "ok" | "idle";

const HUE_ROW: Record<StateHue, string> = {
  owed: "hue-owed", due: "hue-due", meet: "hue-meet", ok: "hue-ok", idle: "hue-idle",
};
const HUE_CHIP: Record<StateHue, string> = {
  owed: "chip-owed", due: "chip-due", meet: "chip-meet", ok: "chip-ok", idle: "chip-idle",
};
const HUE_VAR: Record<StateHue, string> = {
  owed: "var(--st-owed)", due: "var(--st-due)", meet: "var(--st-meet)",
  ok: "var(--st-ok)", idle: "var(--st-idle)",
};

/** Class that paints a row's 3px left state strip. Pair with `.assay-strip`. */
export function rowHueClass(hue: StateHue): string {
  return HUE_ROW[hue];
}

/** Mono, tabular-figured number/label — the readout idiom (counts, ages, IDs). */
export function Readout({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("readout", className)}>{children}</span>;
}

/** Squared, tinted state chip — a micro-label pill in one state hue. */
export function Chip({ hue = "idle", children, className, title }: {
  hue?: StateHue; children: ReactNode; className?: string; title?: string;
}) {
  return (
    <span title={title} className={cx("chip", HUE_CHIP[hue], className)}>{children}</span>
  );
}

/** Ladder pips ●●○ — how far along a cadence a lead is (done of total). */
export function Pips({ done, total, hue = "idle", className, label }: {
  done: number; total: number; hue?: StateHue; className?: string; label?: string;
}) {
  const d = Math.max(0, Math.min(total, done));
  const glyphs = "●".repeat(d) + "○".repeat(Math.max(0, total - d));
  const aria = label ?? `touch ${d} of ${total}`;
  return (
    <span className={cx("pips", className)} style={{ ["--pip-hue" as string]: HUE_VAR[hue] }}
      role="img" aria-label={aria}>
      <span aria-hidden>{glyphs}</span>
    </span>
  );
}

/** The "?" hint — all standing teaching prose lives behind this affordance.
 *  Hover OR keyboard-focus reveals the card; the button carries an accessible
 *  name so a screen-reader user reaches the same explanation. */
export function Hint({ label, children, className }: {
  label: string; children: ReactNode; className?: string;
}) {
  return (
    <span className={cx("hint", className)}>
      <button type="button" aria-label={label}>?</button>
      <span className="hint-card" role="tooltip">{children}</span>
    </span>
  );
}

/** Eyebrow section header: uppercase label + mono count + optional "?" hint,
 *  closed by a hairline rule. The rail/section idiom of every surface. */
export function EyebrowHeader({ label, count, hint, rule = true, right, className }: {
  label: ReactNode; count?: number | string; hint?: { label: string; body: ReactNode };
  rule?: boolean; right?: ReactNode; className?: string;
}) {
  return (
    <div className={cx("assay-eyebrow", className)}>
      <span>{label}</span>
      {count !== undefined && (
        <Readout>{typeof count === "number" ? String(count).padStart(2, "0") : count}</Readout>
      )}
      {hint && <Hint label={hint.label}>{hint.body}</Hint>}
      {rule && <span aria-hidden className="rule" />}
      {right}
    </div>
  );
}
