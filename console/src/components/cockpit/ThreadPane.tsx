"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Action, ErrorState, Hint, Menu, StatusChip, Skeleton, TypeTag, cx, type MenuItem } from "@/components/kit";
import { MessageList } from "./Conversation";
import { DraftCard } from "./PackPreview";
import { IconCalendar, IconNote } from "./icons";
import { closeOutReason, replyBarLabel } from "./prose";
import { day, dayTime, fmtFacts, type ActionParts, type Board, type DirectiveAction, type GateAction, type Note, type Sel, type Thread, type VRow } from "./types";

// RIGHT PANE — COCKPIT-V4 §6 geometry rebuild (2026-07-04).
//
// The v2 layout put the guidance + the ENTIRE draft card in a fixed (shrink-0)
// footer — with a draft present it crushed the conversation to an
// un-expandable sliver (audit defect D3). Now the pane is ONE scroll column
// with three labeled zones:
//
//   CONVERSATION  — full verbatim thread, never truncated
//   GUIDANCE      — operator notes → engine NEXT STEP → AI advisory
//   YOUR REPLY    — the draft card (or the draft action)
//
// plus a pinned one-line reply bar that always shows the draft state and jumps
// between the reply and the conversation. The draft physically cannot crush
// the history because it lives in the scroll flow.

function synthetic(sel: Sel): ActionParts {
  if (sel.kind === "cold") {
    return {
      engine: [`send cold touch ${sel.cold.touches + 1} of 3 (${sel.cold.bizdays_since_out ?? "?"} business days since the last)`],
      archivist: null, archivist_stale: false, notes: 0,
    };
  }
  return { engine: ["joins the next cold outreach pack"], archivist: null, archivist_stale: false, notes: 0 };
}

// V5: THE one agent entry on this screen (operator 2026-07-10 — the Rewrite
// box and preset chips are gone). Free text about the open lead: rewrite the
// draft, attach something, ask a question. Submitting IS the opt-in click
// (tenet 25 — the cost is stated right here); the confirm popup is gone
// (operator 2026-07-12: console-fired runs are innately approved, and the
// popup added a second prompt after the operator already asked for the run).
// Valence starts with this lead's full record and conversation preloaded —
// it does not go re-read everything first.
// V5.1: the box lost its own card chrome — it renders as the FOOT of the
// unified lead console (one outer border up in ThreadPane), field on bg-well.
function CommandBox({ company, busy, onRun }: { company: string; busy: boolean; onRun: (instruction: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => { const t = text.trim(); if (t && !busy) { onRun(t); setText(""); } };
  return (
    <div>
      {busy ? (
        <div className="flex items-center gap-2 text-body text-accent" role="status">
          <span aria-hidden>✦</span> Valence is working on it — {company} only…
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            aria-label={`Tell Valence about ${company}`}
            placeholder={`Tell Valence — reply, confirm a meeting, attach files, anything about ${company}…`}
            className="min-w-0 flex-1 rounded-ctl border border-line-strong bg-well px-3 py-1.5 text-body text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
          />
          <Action onClick={submit} disabled={!text.trim()}>Go</Action>
          {/* the standing explainer lives behind the "?" — teach on demand */}
          <Hint label="What running Valence does">Valence already holds this lead&apos;s record and conversation. Each message is one agent run (under a minute, spends tokens). It never sends email.</Hint>
        </div>
      )}
    </div>
  );
}

function ZoneHead({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-4 pb-1 pt-3">
      <span className="text-micro font-medium uppercase tracking-[0.14em] text-ink-dim">{label}</span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-line" />
      {right && <span className="shrink-0 text-caption text-ink-dim">{right}</span>}
    </div>
  );
}

// V5: notes fold to one quiet line — full history one click away, never a wall
function OperatorNotes({ notes }: { notes: Note[] }) {
  const [open, setOpen] = useState(false);
  if (notes.length === 0) return null;
  return (
    <div className="mb-2.5">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex items-center gap-1.5 text-caption font-medium text-accent underline-offset-2 hover:underline">
        <IconNote /> Your notes ({notes.length})
      </button>
      {open && (
        <div className="mt-1.5 rounded-card border border-accent/35 border-l-2 border-l-accent bg-fill-1 px-3 py-2">
          {notes.map((n, i) => (
            <p key={i} className="text-body text-ink">
              <span className="text-ink-dim">{day(n.ts)} · {n.by === "operator" ? "You" : n.by || "note"}{n.kind && n.kind !== "note" ? ` · ${n.kind}` : ""}: </span>
              {n.note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// V5: the NEXT STEP card and AI SUGGESTION advisory are deleted (operator
// 2026-07-10, "no next steps — the draft is what works"). The engine still
// classifies rows; the draft below carries the suggestion.

export function ThreadPane({ sel, board, busy, instructBusy, today, closeSuggestion, onBack, onDraft, onNudge, onSkip, onUnskip, onAskInfo, onMeet, onGate, onDirective, onInstruct, onChanged, onOpenDrafts, onSendDraft, onAttachDraft, pendingAttachments = [], onPickAttachments, onConfirmMeeting }: {
  sel: Sel; board: Board | null; busy?: string; instructBusy?: boolean; today: string;
  closeSuggestion?: { who?: string; reason?: string } | null;
  onBack: () => void; onDraft: () => void; onNudge: () => void; onSkip: () => void; onUnskip: () => void; onAskInfo: () => void;
  onMeet: () => void; onGate: (a: GateAction) => void; onDirective: (a: DirectiveAction) => void;
  onInstruct: (instruction: string) => void; onChanged: () => void; onOpenDrafts: () => void;
  onSendDraft?: (file: string) => void;
  onAttachDraft?: (file: string, entryIndex: number, current: string[]) => void;
  // pre-draft attachment picks — they ride the next draft run for this company
  pendingAttachments?: string[];
  onPickAttachments?: () => void;
  // packaged confirm-meeting instruct run (2026-07-16)
  onConfirmMeeting?: () => void;
}) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadErr, setThreadErr] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLDivElement>(null);
  const [replyVisible, setReplyVisible] = useState(false);
  const r = sel.kind === "row" ? sel.row : null;
  const journey = board?.journeys[sel.key];
  const decision = board?.decisions[sel.key];

  const loadThread = useCallback(() => {
    setThread(null); setThreadErr(false);
    if (sel.kind === "fresh" && !sel.known) return; // no thread exists yet
    fetch(`/api/thread?key=${encodeURIComponent(sel.key)}`)
      .then((res) => res.ok ? res.json() : Promise.reject())
      .then(setThread).catch(() => setThreadErr(true));
  }, [sel]);
  useEffect(loadThread, [loadThread]);

  // Initial position: the conversation's TAIL fills the pane (latest message
  // in view, guidance/reply below the fold — one scroll or one click away).
  useEffect(() => {
    const sc = scroller.current, guide = guideRef.current;
    if (!thread || !sc || !guide) return;
    const guideTop = guide.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTop = Math.max(0, guideTop - sc.clientHeight + 8);
  }, [thread]);

  // The pinned bar flips direction based on whether the reply zone is on screen.
  useEffect(() => {
    const sc = scroller.current, target = replyRef.current;
    if (!sc || !target) return;
    const io = new IntersectionObserver(([e]) => setReplyVisible(e.isIntersecting), { root: sc, threshold: 0.15 });
    io.observe(target);
    return () => io.disconnect();
  }, [sel.key, thread]);

  // Scroll ONLY the pane's scroller — scrollIntoView also scrolls
  // overflow-hidden ancestors and shoved the whole page up (verified live).
  const jumpToReply = () => {
    const sc = scroller.current, target = replyRef.current;
    if (!sc || !target) return;
    const top = target.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTo({ top, behavior: "smooth" });
  };
  const jumpToConversation = () => scroller.current?.scrollTo({ top: 0, behavior: "smooth" });

  const parts: ActionParts = r?.action_parts ?? (r
    ? { engine: [r.cells.action], archivist: null, archivist_stale: false, notes: r.meta.notes.length }
    : synthetic(sel));
  // ALL note kinds render — operator "decision" rulings especially (they were
  // filtered out until the 2026-07-09 audit; rulings are exactly what must show).
  const notes = r?.meta.notes ?? [];

  const meetingLine = r?.meta.meeting_state === "scheduled" && r.meta.meeting_invite_sent === false
    ? `Meeting ${day(r.meta.meeting_at)} — calendar invite NOT sent yet`
    : r?.meta.meeting_state === "rescheduling" ? "Rescheduling — the old date is cancelled, waiting on a new one"
    : r?.meta.meeting_state === "scheduled" ? `Meeting ${day(r.meta.meeting_at)} — invite sent ✓`
    : r?.meta.meeting_state === "outcome-due" ? `Meeting ${day(r.meta.meeting_at)} passed in silence — log the outcome`
    : null;

  // FRESHNESS GUARD (extends the 2026-07-13 Sirius staleness rule to inbound):
  // a draft authored before their LATEST message may not answer it — say so on
  // the card and put the weight on drafting fresh. Day-level, same as the
  // send-based retirement in deriveJourneys.
  const lastInDay = r?.meta.last_in_date ? r.meta.last_in_date.slice(0, 10) : null;
  const draftStale = !!(journey?.drafted && !journey.packSent && lastInDay
    && journey.drafted.day && lastInDay > journey.drafted.day);

  const range = thread && thread.messages.length > 0
    ? `${thread.messages.length} message${thread.messages.length !== 1 ? "s" : ""} · ${day(thread.messages[0].date)} – ${day(thread.messages[thread.messages.length - 1].date)}`
    : null;

  // "Confirm meeting" affordance: shown when their LATEST message reads like a
  // proposed time slot. This is an action affordance, not a classification —
  // the row never moves lists because of it (tenet 20 intact); the agent run
  // it fires re-reads the real thread and declines honestly if no slot exists.
  const slotText = `${r?.meta.last_in_gist ?? ""} ${r?.meta.last_in_subj ?? ""}`;
  const slotTime = /(\d{1,2}[:.]\d{2}|\d{1,2}\s?(?:am|pm|hrs?\b)|a las\s+\d|\d{3,4}\s*UTC)/i.test(slotText);
  const slotDay = /(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|monday|tuesday|wednesday|thursday|friday|hoy|ma[ñn]ana|tomorrow|today)/i.test(slotText);
  const slotMeet = /(reuni|meet|llamada|videollamada|\bcall\b|\bcita\b|agendar|zoom)/i.test(slotText);
  const slotProposed = slotTime && (slotDay || slotMeet) && r?.meta.meeting_state !== "scheduled";

  const hasLiveDraft = !!(journey?.drafted && !journey.packSent);

  // ONE "More ▾" menu holds every lead action except the pane's single primary
  // (operator 2026-07-16 — reversing the V5.1 "visible buttons" rule; tenet 17
  // amended): schedule / hold / handling-personally / set-aside / pre-draft
  // attach / investigate, then a separator and the destructive trio (Pause,
  // Close out, Do not contact). Every handler, gate and confirm is unchanged.
  const moreItems: MenuItem[] = [
    ...(slotProposed && onConfirmMeeting ? [{ label: "Confirm meeting", onSelect: onConfirmMeeting }] : []),
    ...((r || sel.kind === "cold") ? [{ label: "Schedule meeting", onSelect: onMeet }] : []),
    ...(r ? [r.meta.hold_until
      ? { label: "Bring back now", onSelect: () => onDirective("unhold") }
      : { label: "Hold until…", onSelect: () => onDirective("hold") }] : []),
    ...(r ? [r.meta.personal
      ? { label: "Hand back to automation", onSelect: () => onDirective("release") }
      : { label: "Handling personally", onSelect: () => onDirective("personal") }] : []),
    decision?.decision === "skip"
      ? { label: "Bring back today", onSelect: onUnskip }
      : { label: "Set aside until tomorrow", onSelect: onSkip },
    ...(!hasLiveDraft && onPickAttachments
      ? [{ label: pendingAttachments.length > 0 ? "Change attachments…" : "Attach files…", onSelect: onPickAttachments }] : []),
    { label: "Investigate with the agent…", onSelect: onAskInfo },
    { label: "Pause (reversible)", onSelect: () => onGate("freeze"), separator: true },
    { label: "Close out — mark declined", onSelect: () => onGate("close"), danger: true },
    { label: "Do not contact", onSelect: () => onGate("dnc"), danger: true },
  ];
  const moreMenu = <Menu label="More actions" items={moreItems} align="right" direction="up">More ▾</Menu>;

  return (
    <>
      {/* pane header — stays put */}
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="text-body text-ink-dim hover:text-ink md:hidden" aria-label="Back to the list">←</button>
          <h2 className="min-w-0 truncate text-title font-medium text-ink">{sel.key}</h2>
          {r?.meta.company_class === "test" && <TypeTag>TEST</TypeTag>}
          {decision && decision.decision !== "clear" && <StatusChip tone={decision.decision === "skip" ? "dim" : "info"}>{decision.decision === "needs-info" ? "asking for info" : decision.decision === "skip" ? "set aside" : decision.decision}</StatusChip>}
          {journey?.sent?.startsWith(today) && <StatusChip tone="ok">replied today</StatusChip>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-body text-ink-dim">
          {(r?.meta.people?.length ? r.meta.people : thread?.people ?? []).slice(0, 3).map((p) => <span key={p}>{p}</span>)}
          {meetingLine && (
            <span className={cx("flex items-center gap-1 font-medium",
              meetingLine.includes("NOT sent") || meetingLine.includes("Rescheduling") || meetingLine.includes("silence") ? "text-tone-warn-ink" : "text-tone-ok-ink")}>
              <IconCalendar /> {meetingLine}
            </span>
          )}
        </div>
      </div>

      {/* ONE scroll column: conversation → guidance → your reply */}
      <div ref={scroller} className="thin-scroll min-h-0 flex-1 overflow-y-auto pb-3">
        <ZoneHead label="Conversation" right={range} />
        <div className="px-4">
          {r?.meta.spam_inbound && (
            <p className="mb-2 rounded-card border border-tone-warn/40 bg-tone-warn/[0.06] px-3 py-1.5 text-caption font-medium text-tone-warn-ink">
              Some of their mail arrived via the spam folder — it is folded in below, but check Gmail spam for anything newer.
            </p>
          )}
          {sel.kind === "fresh" && !sel.known ? (
            <p className="text-body text-ink-dim">New lead — no conversation exists yet. It joins the next cold outreach pack; drafting writes its first touch.</p>
          ) : threadErr ? (
            <ErrorState what="the conversation" onRetry={loadThread} />
          ) : !thread ? (
            <Skeleton rows={4} />
          ) : thread.messages.length === 0 ? (
            <p className="text-body text-ink-dim">No messages on file for this company yet.</p>
          ) : (
            // the shared bubble renderer — the Pipeline drawer draws the same one
            <MessageList messages={thread.messages} />
          )}
        </div>

        {/* V5 (operator 2026-07-10): "no next steps — the draft is what works".
            The NEXT STEP card and the AI SUGGESTION advisory are gone; the
            engine's classification still places the row, the draft carries the
            suggestion, and your notes fold to one line. */}
        <div ref={guideRef}>
          <div className="px-4 pt-3">
            <OperatorNotes notes={notes} />
            {closeSuggestion && (
              <div className="mt-2 rounded-card border border-tone-warn/40 border-l-2 border-l-tone-warn bg-tone-warn/[0.06] px-3 py-2">
                <div className="mb-1 text-caption font-medium text-tone-warn-ink">Close-out suggested — the engine reads this lead as dead</div>
                <p className="text-body text-ink">{closeOutReason(closeSuggestion.who, closeSuggestion.reason)}</p>
                <p className="mt-1 text-caption text-ink-dim">Your call — reply, set it aside, or close it out. A closed lead re-opens automatically if they write back with interest.</p>
                <div className="mt-1.5">
                  <Action variant="danger" onClick={() => onGate("close")}>Close out…</Action>
                </div>
              </div>
            )}
          </div>
        </div>

        <div ref={replyRef}>
          <ZoneHead label="Your reply" />
          <div className="px-4">
            {/* unified lead console: ONE outer card — draft (or the draft
                prompt) on top, an action bar with exactly ONE primary + the
                "More ▾" menu, then the Valence input as the foot of the same
                object (CALIBRATED INSTRUMENT, Phase T). */}
            <div className="rounded-card border border-accent/25 bg-fill-1 p-3">
              {busy && (!journey?.drafted || journey.packSent) && (
                <div role="status" aria-label="Drafting">
                  <div className="mb-2 text-body text-accent"><span aria-hidden>✦ </span>Drafting…</div>
                  <div className="h-3 w-2/3 rounded bg-fill-3" style={{ animation: "breathe 1.6s var(--ease-soft) infinite" }} />
                  <div className="mt-2 h-3 w-full rounded bg-fill-2" style={{ animation: "breathe 1.6s var(--ease-soft) infinite", animationDelay: "150ms" }} />
                </div>
              )}
              {/* a SENT pack is history, not a pending reply — its card must never
                  offer Send again (2026-07-12: a delivered draft kept a live Send
                  button and the pane contradicted itself) */}
              {journey?.drafted && !journey.packSent ? (
                <>
                  {draftStale && (
                    <div className="mb-2.5 rounded-card border border-tone-warn/40 border-l-2 border-l-tone-warn bg-tone-warn/[0.06] px-3 py-2">
                      <p className="text-body text-tone-warn-ink">
                        This draft was written {day(journey.drafted.day)}, before their latest message ({day(r?.meta.last_in_date)}) — it may not answer it.
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <Action variant="primary" onClick={onDraft}>✦ Draft a fresh reply</Action>
                        <span className="text-caption text-ink-dim">or rewrite the old one below — your call.</span>
                      </div>
                    </div>
                  )}
                  <DraftCard file={journey.drafted.pack} entry={journey.drafted.entry} staged={!!journey.staged}
                    stagedAt={journey.staged} stale={draftStale} onChanged={onChanged} onOpenDrafts={onOpenDrafts}
                    onSend={onSendDraft}
                    onAttach={(entryIndex, current) => onAttachDraft?.(journey.drafted!.pack, entryIndex, current)}
                    moreMenu={moreMenu} />
                </>
              ) : !busy ? (
                <>
                  {/* the action bar: exactly ONE primary + the More ▾ menu */}
                  {journey?.packSent ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="min-w-0 flex-1 text-body font-medium text-tone-ok-ink">Reply sent{journey.sent ? ` ${day(journey.sent)}` : ""} ✓ — it&apos;s in the conversation above.</span>
                      <Action onClick={onDraft}>Draft another reply</Action>
                      {moreMenu}
                    </div>
                  ) : sel.kind === "row" && sel.sectionId === "nudge" ? (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Action variant="primary" onClick={onNudge}>✦ Nudge now</Action>
                        <Action onClick={onDraft}>Draft a full reply</Action>
                        <span className="min-w-2 flex-1" aria-hidden />
                        {moreMenu}
                      </div>
                      <p className="mt-2 text-caption text-ink-dim">A nudge is three short lines in the house voice — you review it before anything is staged.</p>
                    </>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Action variant="primary" onClick={onDraft}>✦ Draft the reply</Action>
                      <span className="min-w-2 flex-1" aria-hidden />
                      {moreMenu}
                    </div>
                  )}
                  {/* pre-draft attachment picks (the "Attach files…" trigger lives
                      in the More menu now) — the chosen files ride the next draft
                      run and land on the reply it writes. */}
                  {pendingAttachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-caption text-ink-dim">Attaches when the reply is drafted:</span>
                      {pendingAttachments.map((a) => (
                        <span key={a} className="rounded-ctl border border-line bg-well px-2 py-0.5 text-caption text-ink-dim">
                          {a.split("/").pop()}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : null}
              {/* the console's foot: ONE Valence entry, divided — not a sibling card */}
              <div className="mt-2.5 border-t border-line pt-2.5">
                <CommandBox company={sel.key} busy={!!instructBusy} onRun={onInstruct} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* pinned reply bar — wayfinding at label volume (V5.1: weight 500, and
          "Draft ready" wears the accent now that accent ≠ warn) */}
      <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-1.5">
        <span className={cx("min-w-0 flex-1 truncate text-caption font-medium",
          journey?.sent?.startsWith(today) || journey?.staged ? "text-tone-ok-ink" : journey?.drafted ? "text-accent" : "text-ink-dim")}>
          {replyBarLabel(journey, today)}
        </span>
        {replyVisible ? (
          <button onClick={jumpToConversation} className="shrink-0 text-caption text-ink-dim underline-offset-2 hover:text-ink hover:underline">
            ↑ Back to the conversation
          </button>
        ) : (
          <button onClick={jumpToReply} className="shrink-0 text-caption font-medium text-accent underline-offset-2 hover:underline">
            Jump to reply ↓
          </button>
        )}
      </div>
    </>
  );
}
