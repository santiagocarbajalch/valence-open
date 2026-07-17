"use client";

import { Action, Dot, IconButton, Readout, cx } from "@/components/kit";
import { IconMail, IconRefresh } from "./icons";
import { md, type SQ, type View } from "./types";

// The Today HERO strip — CALIBRATED INSTRUMENT (Phase T, 2026-07-17). The
// pipeline-stage FILTER is gone (operator 2026-07-04); the loudest element is
// now a large MONO counter of the day's owed replies, with the date beneath it.
// Every V5 control survives — jump-to-owed (the counter itself), draft-the-day,
// Drafts (a readout pill), add-leads, email format, refresh / new-mail banner,
// system — restyled to the trade palette; nothing was removed.
//   • "Drafts · N" counts staged PACK FILES (any day), a different unit than
//     the board rows, and is labeled as such.
//   • ONE refresh affordance: the icon grows into an amber "New activity" button.

export function TopBar({ today, needReply, onJumpToOwed, sq, view, dayBusy, draftables, onDraftDay, stagedPacks, onOpenDrafts, onOpenLeads, onOpenFormat, onRefresh, onOpenSystem, newMail, onReload, boardLoading }: {
  today: string; needReply: number;
  onJumpToOwed: () => void;
  sq: SQ | null; view: View | null; dayBusy: boolean; draftables: number;
  onDraftDay: () => void; stagedPacks: number; onOpenDrafts: () => void; onOpenLeads: () => void;
  onOpenFormat: () => void; onRefresh: () => void; onOpenSystem: () => void;
  newMail: boolean; onReload: () => void; boardLoading?: boolean;
}) {
  const dateStr = new Date(today + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const owed = needReply > 0;
  return (
    <header className="shrink-0 px-4 pt-3">
      <div className="glass mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-5 gap-y-2 rounded-pane px-5 py-3">
        {/* the day's to-do — a large mono counter, the single loudest element */}
        <button onClick={onJumpToOwed}
          title="Jump to the companies waiting on an answer"
          className="flex items-center gap-3.5 text-left transition-opacity hover:opacity-90">
          <Readout className={cx("text-hero leading-none", owed ? "text-tone-bad-ink" : "text-tone-ok-ink")}>
            {owed ? String(needReply).padStart(2, "0") : "00"}
          </Readout>
          <span className="flex flex-col leading-tight">
            <span className={cx("text-caption font-semibold uppercase tracking-[0.09em]", owed ? "text-tone-bad-ink" : "text-tone-ok-ink")}>
              {owed ? `Need${needReply === 1 ? "s" : ""} a reply` : "Nothing owed ✓"}
            </span>
            <Readout className="text-caption text-ink-dim">{dateStr}</Readout>
          </span>
        </button>

        {/* V5 (operator 2026-07-10): safety states speak ONLY when something is wrong. */}
        {sq && (sq.paused || !sq.sendEnabled) && (
          <button onClick={onOpenSystem}
            title={sq.paused ? `Sending is paused: ${sq.pauseReason ?? "see system status"}` : "Approved sends are held; nothing leaves the building"}
            className={cx("rounded-full border px-2.5 py-[3px] text-caption font-medium transition-colors hover:bg-fill-2",
              sq.paused ? "border-tone-bad/50 text-tone-bad-ink" : "border-line-strong text-ink-dim")}>
            Sending: {sq.paused ? "PAUSED" : "OFF"}
          </button>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {view && !view.certified && (
            <button onClick={onOpenSystem}
              title="The independent data check failed — treat the board as suspect. Click for details."
              className="flex items-center gap-1.5 rounded-full border border-tone-bad/60 bg-tone-bad/10 px-2.5 py-1 text-body font-medium text-tone-bad-ink transition-colors hover:bg-fill-2">
              <Dot decorative tone="bad" />
              ⚠ Data check failed
            </button>
          )}
          {dayBusy ? (
            <span className="flex items-center gap-1.5 rounded-ctl border border-tone-info/35 px-2.5 py-1 text-body text-tone-info-ink">
              <Dot decorative tone="info" /> Drafting…
            </span>
          ) : draftables > 0 ? (
            <Action variant="primary" onClick={onDraftDay}><span aria-hidden>✦ </span>Draft the day ({draftables})</Action>
          ) : null}
          {/* Drafts — a mono readout pill (staged packs waiting, any day) */}
          <button onClick={onOpenDrafts}
            aria-label={`Drafts prepared earlier and not yet sent${stagedPacks > 0 ? ` — ${stagedPacks} waiting` : ""}`}
            title="Drafts prepared earlier and not yet sent — including cold batches."
            className="work-pill">
            <span aria-hidden>✎</span> Drafts{stagedPacks > 0 && <> <Readout>{stagedPacks}</Readout></>}
          </button>
          <Action onClick={onOpenLeads}>Add leads</Action>
          <IconButton label="Email format — how outgoing mail looks" onClick={onOpenFormat}><IconMail /></IconButton>
          {newMail ? (
            <button onClick={onReload}
              className="flex items-center gap-1.5 rounded-ctl border border-tone-warn/50 bg-tone-warn/10 px-2.5 py-1 text-body font-medium text-tone-warn-ink transition-colors hover:bg-tone-warn/20">
              <Dot decorative tone="warn" /> New activity — refresh
            </button>
          ) : (
            <IconButton label={boardLoading ? "Refreshing the board…" : "Refresh the board and drafts"} onClick={onRefresh}>
              <span aria-hidden className={cx("inline-flex", boardLoading && "animate-spin")}><IconRefresh /></span>
            </IconButton>
          )}
        </div>
      </div>

      {view && !view.certified && (
        <div role="alert" className="mx-auto mt-2 w-full max-w-[1440px] rounded-card border border-tone-bad/45 bg-tone-bad/10 px-3.5 py-2 text-body text-tone-bad-ink">
          {view.cert.lines.map((l, i) => <div key={i}>{md(l)}</div>)}
          <div className="mt-0.5 text-caption text-ink-dim">A wrong board is worse than a late one — fix the source before acting on rows.</div>
        </div>
      )}
    </header>
  );
}
