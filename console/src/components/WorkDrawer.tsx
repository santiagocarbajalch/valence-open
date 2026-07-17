"use client";

import { useEffect, useRef, useState } from "react";
import { Action } from "@/components/kit";
import type { TasksState, TaskRow } from "@/lib/useTasks";

// THE WORK DRAWER — a FIXED right-side overlay (never a flex sibling of the
// view, so it can never reflow or swallow clicks meant for the page). Opened
// from the sidebar's work pill; a fresh failure opens it on its own. Escape
// and a click on the backdrop close it. Every behavior the old docked tray
// carried survives: live progress bars, blocked-check details, the
// staged-waiting "Open send screen" hand-off, per-row dismiss.

function minutesSince(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "just started";
  if (m === 1) return "1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function clockTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function WorkDrawer({ tasks, onShowView, onOpenSend }: {
  tasks: TasksState;
  onShowView: (view: string) => void;
  onOpenSend: (packFile: string) => void;
}) {
  const { open, setOpen, live, attention, doneRows, headline, failed, dismiss } = tasks;
  const [expanded, setExpanded] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes; focus lands in the panel on open, returns to the opener on
  // close (same dialog contract as the kit Drawer).
  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      restore?.focus?.();
    };
  }, [open, setOpen]);

  if (!open) return null;

  return (
    // z-50 overlay: a transparent backdrop catches outside clicks; the panel is
    // position:fixed (globals .work-drawer-panel) — content never reflows.
    <div className="fixed inset-0 z-50" onMouseDown={() => setOpen(false)}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Background work"
        className="work-drawer-panel outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <span className="text-caption font-medium text-ink">Background work</span>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close"
            className="rounded-ctl px-2 py-1 text-ink-dim hover:bg-fill-2 hover:text-ink">✕</button>
        </div>

        {/* headline; the failure count is announced politely (a11y audit) */}
        <p className="border-b border-line px-4 py-1.5 text-caption text-ink-dim" aria-live="polite">
          {failed > 0 ? <span className="font-medium text-tone-bad-ink">{headline}</span> : headline}
        </p>

        <div className="thin-scroll">
          {/* live work first — with a filling bar while it runs */}
          {live.map((r) => (
            <div key={r.id} className="border-b border-line px-4 py-2.5">
              <p className="text-caption font-medium text-ink">{r.title}</p>
              <p className="mt-0.5 text-caption text-ink-dim" role="status">
                Working{r.progress ? ` — ${r.progress}` : ""} · {minutesSince(r.startedAt)}
              </p>
              {typeof r.done === "number" && typeof r.total === "number" && r.total > 0 && (
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-fill-2" role="progressbar"
                  aria-valuemin={0} aria-valuemax={r.total} aria-valuenow={r.done}>
                  <div className="h-full rounded-full bg-accent transition-[width] duration-500"
                    style={{ width: `${Math.min(100, Math.round((r.done / r.total) * 100))}%` }} />
                </div>
              )}
            </div>
          ))}

          {/* then everything that needs the operator */}
          {attention.map((r) => (
            <div key={r.id} className={`border-b border-line px-4 py-2.5 ${r.ok === false ? "bg-tone-bad/[0.06]" : ""}`}>
              <p className="text-caption font-medium text-ink">{r.title}</p>

              {r.kind === "staged-waiting" && (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-caption text-ink-dim">Checks passed. Nothing sends until you confirm.</p>
                  {r.packFile && (
                    <Action variant="primary" onClick={() => onOpenSend(r.packFile!)}>Open send screen</Action>
                  )}
                  <Action onClick={() => dismiss(r.id)}>Dismiss</Action>
                </div>
              )}

              {r.ok === false && (
                <div className="mt-0.5">
                  <p className="text-caption text-tone-bad-ink" role="alert">
                    {r.kind === "stage" && "Blocked — nothing was staged or sent."}
                    {r.kind === "send" && `Send stopped early${r.progress ? ` at ${r.progress}` : ""}.`}
                    {r.kind !== "stage" && r.kind !== "send" && "This task failed."}
                  </p>
                  {expanded === r.id && r.failure && (
                    <pre className="thin-scroll mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-ctl border border-line bg-well px-2 py-1.5 font-sans text-caption text-ink">{r.failure}</pre>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Action onClick={() => setExpanded((e) => (e === r.id ? null : r.id))}>
                      {expanded === r.id ? "Hide details" : "Show details"}
                    </Action>
                    <Action onClick={() => onShowView(r.view ?? "cockpit")}>Go to Today</Action>
                    <Action onClick={() => dismiss(r.id)}>Dismiss</Action>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* the log — what already happened, newest first */}
          {doneRows.length > 0 && (
            <>
              <p className="border-b border-line bg-well px-4 py-1.5 text-caption font-medium uppercase tracking-wide text-ink-dim">Done</p>
              {doneRows.map((r) => (
                <div key={r.id} className="flex items-baseline gap-2 border-b border-line px-4 py-1.5 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-caption text-ink">{r.title}</p>
                    <p className="text-caption text-ink-dim">
                      {r.kind === "send" && r.progress ? `${r.progress} · ` : ""}{clockTime(r.endedAt)}
                    </p>
                  </div>
                  <button type="button" onClick={() => dismiss(r.id)} aria-label={`Dismiss ${r.title}`}
                    className="shrink-0 cursor-pointer text-caption text-ink-dim hover:text-ink">Dismiss</button>
                </div>
              ))}
            </>
          )}

          {live.length === 0 && attention.length === 0 && doneRows.length === 0 && (
            <p className="px-4 py-6 text-center text-caption text-ink-dim">No background work right now.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export type { TaskRow };
