"use client";

// Valence kit — shared UI primitives for every surface (cockpit included).
// Drop-in prop-compatible with the old cockpit/ui.tsx exports; tokens only.

import { useState } from "react";
import { TONE, TONE_INK, toneMix, type Tone } from "./tokens";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// status meaning = a glowing dot (the system's idiom), never an emoji.
// Carries a text label so meaning isn't color-only (WCAG 1.4.1).
const TONE_LABEL: Record<Tone, string> = { ok: "good", warn: "attention", bad: "urgent", info: "info", dim: "idle" };

export function Dot({ tone, title, decorative }: { tone: Tone; title?: string; decorative?: boolean }) {
  const c = TONE[tone];
  const label = title ?? TONE_LABEL[tone];
  // decorative: purely visual (sits next to text that already carries the
  // meaning) — hidden from assistive tech so it can never hijack the
  // accessible name of a parent button (the section-header bug).
  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label, title: label })}
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: c, boxShadow: `0 0 8px ${c}` }}
    />
  );
}

export function Pill({ tone = "dim", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className="vk-chip rounded-full border px-2 py-[1px] text-caption leading-tight"
      style={{ borderColor: toneMix(TONE[tone], 34), color: TONE_INK[tone] }}
    >
      {children}
    </span>
  );
}

// ── v4 chip taxonomy (COCKPIT-V4 §3.1) — one shape per meaning ───────────────
// StatusChip = the STATE of an item (filled, round, lowercase).
// TypeTag    = a classification (squared, outline, uppercase micro).
// NoteChip   = an operator annotation marker (accent, pen glyph).
// Legacy `Pill` remains only for surfaces not yet migrated.

export function StatusChip({ tone = "dim", children }: { tone?: Tone; children: React.ReactNode }) {
  const c = TONE[tone];
  return (
    <span
      className="vk-chip inline-flex items-center rounded-full border px-2 py-[2px] text-caption leading-tight"
      style={{ color: TONE_INK[tone], borderColor: toneMix(c, 45), background: toneMix(c, 12) }}
    >
      {children}
    </span>
  );
}

export function TypeTag({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title}
      className="vk-chip vk-tag inline-flex items-center rounded-ctl border border-line-strong px-1.5 py-[2px] text-micro uppercase tracking-wide text-ink-dim">
      {children}
    </span>
  );
}

export function NoteChip({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-ctl border border-accent/40 px-1.5 py-[1px] text-caption leading-tight text-accent">
      <span aria-hidden>✎</span> {count} note{count > 1 ? "s" : ""}
    </span>
  );
}

/** Colored-dot status chip for arbitrary state strings (was 3 local StatePills). */
export function StatusPill({ tone = "dim", label }: { tone?: Tone; label: string }) {
  const c = TONE[tone];
  return (
    <span
      className="vk-chip inline-flex items-center gap-1.5 rounded-full border px-2 py-[2px] font-mono text-micro uppercase tracking-wide"
      style={{ color: TONE_INK[tone], borderColor: toneMix(c, 30) }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} /> {label}
    </span>
  );
}

type Variant = "primary" | "neutral" | "danger" | "ghost";
export function Action({ children, onClick, variant = "neutral", disabled, title }: {
  children: React.ReactNode; onClick?: () => void; variant?: Variant; disabled?: boolean; title?: string;
}) {
  const base = "vk-btn rounded-ctl px-2.5 py-1 text-caption transition-colors disabled:opacity-40";
  const styles: Record<Variant, string> = {
    // primary text = --accent-contrast: dark ink on gold in BOTH themes.
    // (text-bg-0 went near-white in light mode — the failing-contrast audit.)
    primary: "vk-btn-primary font-medium text-accent-contrast bg-accent",
    neutral: "vk-btn-neutral border border-line-strong text-ink-dim hover:bg-fill-2 hover:text-ink",
    danger: "vk-btn-danger border border-tone-bad/45 text-tone-bad-ink hover:bg-tone-bad/10",
    ghost: "vk-btn-ghost text-ink-dim hover:text-ink",
  };
  return (
    <button title={title} onClick={onClick} disabled={disabled} className={cx(base, styles[variant])}>
      {children}
    </button>
  );
}

/** Small square affordance (close ✕, refresh ⟳) with an accessible name AND a
 *  visible tooltip on hover/focus (.tip in globals.css) — an icon-only button
 *  must never make a sighted beginner guess. */
export function IconButton({ label, onClick, children, className }: {
  label: string; onClick?: () => void; children: React.ReactNode; className?: string;
}) {
  return (
    <button aria-label={label} data-tip={label} onClick={onClick}
      className={cx("vk-btn vk-btn-neutral tip rounded-ctl border border-line-strong px-2 py-1 text-ink-dim transition-colors hover:bg-fill-2 hover:text-ink", className)}>
      {children}
    </button>
  );
}

export function Stat({ label, value, sub, tone = "dim" }: { label: string; value: string; sub: string; tone?: Tone }) {
  return (
    <div className="glass rounded-card px-3.5 py-2.5">
      <div className="eyebrow">{label}</div>
      <div className="mt-0.5 text-display" style={{ color: tone === "dim" ? "var(--ink)" : TONE_INK[tone] }}>{value}</div>
      <div className="text-caption text-ink-dim">{sub}</div>
    </div>
  );
}

/** Bare key/value pair for stat grids inside a Card (no glass of its own). */
export function KV({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="font-mono text-title leading-none text-ink">{v}</div>
      <div className="mt-1 text-micro uppercase tracking-wide text-ink-dim">{k}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="glass grid h-48 place-items-center rounded-pane px-8 text-center">
      <div className="flex flex-col items-center gap-2 text-caption text-ink-dim">
        <span aria-hidden className="text-title opacity-50">◇</span>
        <span>{children}</span>
      </div>
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="glass rounded-card px-4 py-3.5"
          style={{ animation: "breathe 2.2s var(--ease-soft) infinite", animationDelay: `${i * 120}ms` }}>
          <div className="h-3 w-1/3 rounded bg-fill-3" />
          <div className="mt-2 h-2.5 w-3/4 rounded bg-fill-2" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="glass grid h-48 place-items-center rounded-pane">
      <div className="text-center">
        <span aria-hidden className="mb-1 block text-title text-tone-bad-ink opacity-70">◇</span>
        <p className="text-body text-tone-bad-ink">Couldn&apos;t load {what}.</p>
        <button onClick={onRetry}
          className="mt-2 rounded-ctl border border-line-strong px-3 py-1.5 text-caption text-ink-dim hover:bg-fill-2">
          Retry
        </button>
      </div>
    </div>
  );
}

// Non-destructive truncation: clamp by CSS, full text on hover, optional expand.
export function Clamp({ text, lines = 2, expandable, className }: {
  text: string; lines?: 1 | 2 | 3; expandable?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className={cx("text-ink-faint", className)}>—</span>;
  const clampCls = open ? "" : lines === 1 ? "line-clamp-1" : lines === 2 ? "line-clamp-2" : "line-clamp-3";
  if (expandable) {
    return (
      <button type="button" title={text} aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className={cx("cursor-pointer text-left", clampCls, className)}>
        {text}
      </button>
    );
  }
  return <span title={text} className={cx(clampCls, className)}>{text}</span>;
}

export function PageHeader({ title, eyebrow, right }: { title: string; eyebrow?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-title font-medium tracking-tight text-ink">{title}</h2>
        {eyebrow && <p className="eyebrow mt-1">{eyebrow}</p>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}

/** Mono uppercase eyebrow — the section-label idiom, with an optional right slot. */
export function SectionLabel({ children, right, className }: {
  children: React.ReactNode; right?: React.ReactNode; className?: string;
}) {
  return (
    <div className={cx("mb-2 flex items-center justify-between gap-3", className)}>
      <span className="eyebrow">{children}</span>
      {right}
    </div>
  );
}

/** Glass pane with an optional titled header row. */
export function Card({ title, pill, children, className }: {
  title?: string; pill?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={cx("vk-card glass rounded-pane p-5", className)}>
      {(title || pill) && (
        <div className="mb-3 flex items-center justify-between">
          {title && <h3 className="text-body font-medium text-ink">{title}</h3>}
          {pill}
        </div>
      )}
      {children}
    </div>
  );
}

/** The segmented pill nav used by the shell, Health and Team sub-views. */
export function TabBar<T extends string>({ tabs, active, onChange, className }: {
  tabs: { id: T; label: string }[]; active: T; onChange: (id: T) => void; className?: string;
}) {
  return (
    // max-w-full + overflow-x-auto: at narrow widths the bar scrolls inside
    // itself instead of silently clipping the last tabs (680px audit fix)
    <nav className={cx("vk-tabs flex max-w-full min-w-0 items-center gap-1 overflow-x-auto rounded-full border border-line bg-fill-1 p-0.5", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          aria-current={active === t.id ? "page" : undefined}
          className={cx(
            "vk-tab shrink-0 whitespace-nowrap rounded-full px-3.5 py-1 text-caption transition-colors",
            // active state must be readable at a glance (v4 §3.5): full ink,
            // medium weight, and an accent underline bar — not a faint fill.
            active === t.id
              ? "bg-fill-3 font-medium text-ink shadow-[inset_0_-2px_0_var(--accent),inset_0_1px_0_var(--glass-highlight)]"
              : "text-ink-dim hover:text-ink",
          )}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

/** Consistent interactive row list — one hover/border treatment everywhere. */
export function RowList({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("flex flex-col gap-2", className)}>{children}</div>;
}

export function RowItem({ onClick, children, className, accent }: {
  onClick?: () => void; children: React.ReactNode; className?: string; accent?: string;
}) {
  const base = "vk-row flex w-full items-center gap-4 rounded-card border border-line bg-fill-1 px-4 py-3 text-left";
  const style = accent ? { borderColor: toneMix(accent, 24) } : undefined;
  if (!onClick) return <div className={cx(base, className)} style={style}>{children}</div>;
  return (
    <button onClick={onClick} style={style}
      className={cx(base, "transition-colors hover:border-line-strong hover:bg-fill-2", className)}>
      {children}
    </button>
  );
}
