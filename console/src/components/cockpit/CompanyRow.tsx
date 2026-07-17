"use client";

import { cx } from "@/components/kit";

// THE company row — one anatomy on every surface (ONE DESK port, 2026-07-12).
// Today's rail and the Pipeline board each hand-built this two-line row and
// the copies had already drifted; now both render this component. Shape:
// company + dedicated top-right time slot, preview one step quieter, ONE
// state word on the right in the list's tone. The left inset bar carries the
// list/column accent; selection swaps it for the accent at 4px.
export function CompanyRow({ name, when, gist, word, tone, tint, wordColor, selected, current, onClick }: {
  name: string;
  when?: string | null;
  gist: string;
  word?: string | null;
  tone: string;            // the list/column accent (left inset bar)
  tint?: string;           // whisper row tint (Today's rail lists only)
  wordColor?: string;      // AA ink for the state word; defaults to ink-dim
  selected?: boolean;
  current?: boolean;       // aria-current, when the surface tracks a selection
  onClick?: () => void;
}) {
  return (
    <button onClick={onClick} aria-current={current}
      className={cx("vk-boardrow flex w-full min-w-0 flex-col rounded-card px-2.5 py-2 text-left transition-colors",
        selected ? "bg-fill-3" : "hover:bg-fill-1")}
      style={{
        boxShadow: selected ? "inset 4px 0 0 var(--accent)" : `inset 3px 0 0 ${tone}`,
        background: selected ? undefined : tint,
      }}>
      <span className="flex w-full items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">{name}</span>
        {when && <span className="shrink-0 text-micro tabular-nums text-ink-dim">{when}</span>}
      </span>
      <span className="flex w-full items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-caption text-ink-dim">{gist}</span>
        {word && (
          <span className="shrink-0 text-micro font-medium" style={{ color: wordColor ?? "var(--ink-dim)" }}>
            {word}
          </span>
        )}
      </span>
    </button>
  );
}
