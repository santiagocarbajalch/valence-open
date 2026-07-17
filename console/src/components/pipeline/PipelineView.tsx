"use client";

import { useEffect, useMemo, useState } from "react";
import { Action, AssayRow, ConfirmModal, Drawer, Empty, EyebrowHeader, Hint, Readout, Skeleton, Toaster, toast, type StateHue } from "@/components/kit";
import { relStamp, stateWord } from "@/components/cockpit/BoardList";
import { Conversation } from "@/components/cockpit/Conversation";
import { GATE_DONE_WORD, GateConfirm } from "@/components/cockpit/GateConfirm";
import { IconChevron } from "@/components/cockpit/icons";
import { PIPELINE_BLURBS, PIPELINE_NOTES, ladderWord, pausedLine, pauseSelectedLabel, sentRepliesChip } from "@/components/cockpit/prose";
import { useBoard } from "@/lib/useBoard";
import { day, type ColdVRow, type VRow } from "@/components/cockpit/types";

// ─────────────────────────────────────────────────────────────────────────────
// PIPELINE — the whole field (operator GO 2026-07-12; CALIBRATED INSTRUMENT
// re-layout 2026-07-17).
//
// Today answers "what do I act on right now?". This tab answers the other
// question: "where is EVERY tracked company, and who should I resurface?"
//
// The layout follows the work: the three ACTION partitions that carry live
// conversation (their move / your move / meetings) render first as cards of
// assay-strip rows. The HEAVY/dead partitions (cold ladder, finished the
// ladder, paused, closed) are full-width COLLAPSED count-headers — a title, a
// mono count, a one-phrase note and a "?" hint carrying the standing blurb —
// that expand inline to their real rows. It NEVER re-derives a classification
// (doctrine tenet 20; a column = an engine partition), only partitions the
// meeting-bearing rows into their own action card (tenet 10, disjoint).
//
// Actions here are the registry gates only (pause / reactivate / close out /
// do-not-contact) — reply, nudge and send work stays on Today, where the full
// draft machinery lives. Bulk exists in exactly one place: pausing cold leads
// that finished the ladder (bulk IS the operator's intent there, tenet 22),
// living inside the Finished count-header's expansion.
// ─────────────────────────────────────────────────────────────────────────────

type ColId = "their" | "yours" | "meet" | "ladder" | "finished" | "paused" | "closed";

// the three live-work action cards (rendered first, side by side)
const ACTION_COLS: { id: "their" | "yours" | "meet"; label: string; hue: StateHue; blurb: string; hintLabel: string; empty: string }[] = [
  { id: "their", label: "Their move", hue: "owed", blurb: PIPELINE_BLURBS.owe, hintLabel: "What is Their move?", empty: "Nobody is waiting on you." },
  { id: "yours", label: "Your move", hue: "due", blurb: PIPELINE_BLURBS.them, hintLabel: "What is Your move?", empty: "Nothing on your side right now." },
  { id: "meet", label: "Meetings", hue: "meet", blurb: PIPELINE_BLURBS.meetings, hintLabel: "What is Meetings?", empty: "No meetings on the calendar." },
];

// the four heavy/dead count-headers (full-width, collapsed by default)
const HEAVY_COLS: { id: "ladder" | "finished" | "paused" | "closed"; label: string; blurbKey: string; hintLabel: string }[] = [
  { id: "ladder", label: "Cold ladder", blurbKey: "scheduled", hintLabel: "What is the cold ladder?" },
  { id: "finished", label: "Finished the ladder", blurbKey: "finished", hintLabel: "What is finished the ladder?" },
  { id: "paused", label: "Paused", blurbKey: "paused", hintLabel: "What is paused?" },
  { id: "closed", label: "Closed as declined", blurbKey: "closed", hintLabel: "What is closed as declined?" },
];

// map a row's section (and its one quiet word) to a state hue for the 3px strip
function hueForRow(sectionId: string, word: string | null): StateHue {
  if (word && /bounced/i.test(word)) return "owed";
  if (sectionId === "reply" || sectionId === "contacted" || sectionId === "look") return "owed";
  if (sectionId === "nudge") return "due";
  if (word && /meeting|invite|reschedul/i.test(word)) return "meet";
  if (sectionId === "institutional") return "meet";
  return "idle";
}

// one row, whatever partition it came from — everything the card needs to draw
interface PRow {
  key: string;
  secondary: string;   // who / gist / reason
  word: string | null; // the one quiet state word
  when: string | null; // relative stamp of the last event
  quietDays: number | null;
  hue: StateHue;
  pips?: { done: number; total: number; label: string } | null; // cold rows
  row?: VRow;          // live/paused/closed rows keep the full canonical row
  cold?: ColdVRow;     // ladder rows keep the cold row
}

const fromVRow = (r: VRow, sectionId: string): PRow => {
  // the SAME vocabulary Today's rail speaks (ONE DESK port) — the bid-desk word
  // stays so a routed desk reads distinctly inside "Your move"
  const word = stateWord(r, sectionId);
  return {
    key: r.key,
    secondary: r.meta.last_in_gist || r.meta.last_in_from || r.meta.people[0] || "no named contact",
    word,
    when: relStamp((r.meta.last_in_date ?? "") > (r.meta.last_out_date ?? "") ? r.meta.last_in_date : r.meta.last_out_date || r.meta.last_in_date),
    quietDays: r.meta.bizdays_since_out ?? null,
    hue: hueForRow(sectionId, word),
    row: r,
  };
};

const fromCold = (c: ColdVRow): PRow => {
  const done = Math.min(3, c.touches);
  const label = ladderWord(c.touches, c.cold_substate, c.next_due);
  return {
    key: c.key,
    secondary: c.contact || "no named contact",
    word: null,
    when: relStamp(c.last_out_date),
    quietDays: c.bizdays_since_out ?? null,
    hue: c.cold_substate === "due" ? "due" : "idle",
    pips: { done, total: 3, label },
    cold: c,
  };
};

const fromRegistry = (r: VRow): PRow => ({
  key: r.key,
  secondary: r.meta.suppressed === "closed"
    ? (r.meta.last_in_date ? `declined · last heard ${day(r.meta.last_in_date)}` : "declined")
    : pausedLine(r.meta),
  word: null,
  when: relStamp(r.meta.frozen_meta?.frozen_on ?? r.meta.last_in_date),
  quietDays: r.meta.bizdays_since_out ?? null,
  hue: "idle",
  row: r,
});

export function PipelineView({ onOpenToday }: {
  // ONE DESK port: hands a live company off to Today with the row preselected
  onOpenToday?: (key: string) => void;
}) {
  // the shared board feed — same fetch + optimistic-hide contract as Today
  const { board, view, err, loading, hidden, hide, hideAll, load } = useBoard();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<PRow | null>(null);
  const [selCol, setSelCol] = useState<ColId | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkPause, setBulkPause] = useState(false);
  const [openCols, setOpenCols] = useState<Set<ColId>>(new Set());
  const [gate, setGate] = useState<{ action: "freeze" | "unfreeze" | "close" | "dnc"; row: PRow } | null>(null);

  useEffect(() => { load(); }, [load]);

  // the seven partitions — engine enums only, never re-derived here
  const columns = useMemo(() => {
    const empty: Record<ColId, PRow[]> = { their: [], yours: [], meet: [], ladder: [], finished: [], paused: [], closed: [] };
    if (!view) return empty;
    const rows = (id: string) => view.sections.find((s) => s.id === id)?.rows ?? [];
    // meeting-bearing rows live in exactly one card — Meetings (tenet 10)
    const meetKeys = new Set(view.meetings.map((m) => m.key));
    const notMeet = (r: PRow) => !meetKeys.has(r.key);
    const byKey = new Map<string, VRow>();
    for (const s of view.sections) for (const r of s.rows) byKey.set(r.key, r);

    const out: Record<ColId, PRow[]> = {
      their: [...rows("reply"), ...rows("contacted")]
        .map((r) => fromVRow(r, r.meta.state === "inbound-only" ? "contacted" : "reply")).filter(notMeet),
      yours: [
        ...(["nudge", "inflight", "personal", "held", "closeout"] as const).flatMap((id) => rows(id).map((r) => fromVRow(r, id))),
        ...rows("institutional").map((r) => fromVRow(r, "institutional")),
      ].filter(notMeet),
      meet: view.meetings.map((m) => {
        const r = byKey.get(m.key);
        if (r) return fromVRow(r, "meet");
        return { key: m.key, secondary: m.line.replace(/\*\*/g, "").replace(/^-\s*/, ""), word: m.state, when: relStamp(m.at), quietDays: null, hue: "meet" as StateHue };
      }),
      ladder: [...view.cold_rows.due, ...(view.cold_rows.not_due ?? [])].map(fromCold),
      finished: [...view.cold_rows.exhausted].map(fromCold).sort((a, b) => (b.quietDays ?? 0) - (a.quietDays ?? 0)),
      paused: view.frozen_rows.filter((r) => r.meta.suppressed === "frozen").map(fromRegistry),
      closed: view.frozen_rows.filter((r) => r.meta.suppressed === "closed").map(fromRegistry),
    };
    for (const id of Object.keys(out) as ColId[]) out[id] = out[id].filter((r) => !hidden.has(r.key));
    return out;
  }, [view, hidden]);

  // search filters every card; each header shows "n of m" while filtering
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!needle) return columns;
    const hit = (r: PRow) => r.key.toLowerCase().includes(needle) || r.secondary.toLowerCase().includes(needle);
    const out = {} as Record<ColId, PRow[]>;
    for (const id of Object.keys(columns) as ColId[]) out[id] = columns[id].filter(hit);
    return out;
  }, [columns, needle]);

  const totalTracked = view?.meta.companies_total ?? 0;
  const totalShown = (Object.keys(shown) as ColId[]).reduce((n, id) => n + shown[id].length, 0);

  // ── registry writes (the gates Today already uses; same route, same guards) ─
  const runGate = async (action: "freeze" | "unfreeze" | "close" | "dnc", row: PRow, reason: string) => {
    setGate(null);
    const email = row.row?.meta.people[0] ?? row.cold?.people[0] ?? "";
    const body: Record<string, unknown> = { action, reason, domain: row.key, company: row.key };
    if (action === "dnc") body.email = email || (row.key.includes("@") ? row.key : "");
    const res = await fetch("/api/gating", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { toast(`Couldn't save that for ${row.key}: ${(await res.json()).error ?? "error"}`, { tone: "bad" }); return; }
    toast(`${row.key} — ${GATE_DONE_WORD[action]}`, { tone: action === "unfreeze" ? "ok" : action === "freeze" ? "info" : "warn" });
    hide(row.key);
    setSel(null);
    load({ force: true });
  };

  const runBulkPause = async (reason: string) => {
    setBulkPause(false);
    const targets = columns.finished.filter((r) => picked.has(r.key))
      .map((r) => ({ domain: r.key, company: r.key, email: r.cold?.people[0] ?? "" }));
    if (targets.length === 0) return;
    const res = await fetch("/api/gating", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "freeze", reason, companies: targets }),
    });
    const d = await res.json().catch(() => ({} as { error?: string; added?: number; already?: number }));
    if (!res.ok) { toast(`Couldn't pause the group: ${d.error ?? "error"}`, { tone: "bad" }); return; }
    toast(`${d.added ?? targets.length} compan${(d.added ?? targets.length) === 1 ? "y" : "ies"} paused${d.already ? ` · ${d.already} already were` : ""}`, { tone: "ok" });
    hideAll(targets.map((t) => t.domain));
    setPicked(new Set());
    load({ force: true });
  };

  const toggleCol = (id: ColId) => setOpenCols((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // the row body — an assay strip, shared with Today's rail
  const renderRow = (r: PRow, col: ColId) => (
    <AssayRow key={r.key} name={r.key} hue={r.hue}
      chip={r.pips ? null : r.word} chipHue={r.word && /bounced/i.test(r.word) ? "owed" : r.hue}
      pips={r.pips ?? null} when={r.when} gist={r.secondary}
      selected={sel?.key === r.key} onClick={() => { setSel(r); setSelCol(col); }} />
  );

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className="thin-scroll mx-auto h-full max-w-[1280px] overflow-y-auto px-4 pb-8 pt-3">
      {/* header — orientation + search; every number says what it counts */}
      <div className="flex flex-wrap items-baseline gap-3 pb-3">
        <div className="min-w-0">
          <h1 className="text-display font-medium text-ink">Pipeline</h1>
          <p className="text-caption text-ink-dim">
            Every tracked company, by where it stands. Reply and send work lives on Today; here you pause, reactivate and resurface.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a company…"
            aria-label="Find a company"
            className="w-[220px] rounded-ctl border border-line-strong bg-well px-3 py-1.5 text-body text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
          <Action onClick={() => load()} title="Re-read the board now">Reload</Action>
        </div>
      </div>

      {err && (
        <div className="rounded-card border border-tone-bad/40 bg-tone-bad/[0.06] px-3 py-2 text-body text-tone-bad-ink">
          Couldn&apos;t load the board.{" "}
          <button onClick={() => load()} className="font-medium underline underline-offset-2">Retry</button>
        </div>
      )}
      {loading && !board && <Skeleton rows={6} />}

      {view && (
        <>
          <p className="mb-3">
            <Readout className="text-body text-ink-dim">
              {needle ? `${totalShown} of ${totalTracked}` : totalTracked} companies
            </Readout>
          </p>

          {/* the three action cards — live conversation work, side by side */}
          <section aria-label="What needs a move" className="flex flex-col items-stretch gap-3.5 lg:flex-row lg:items-start">
            {ACTION_COLS.map((c) => {
              const rows = shown[c.id];
              const all = columns[c.id];
              return (
                <section key={c.id} id={`pipeline-col-${c.id}`} aria-label={c.label}
                  className="vk-pane glass min-w-0 flex-1 rounded-pane p-3.5">
                  <EyebrowHeader label={c.label} count={needle ? `${rows.length} of ${all.length}` : all.length}
                    hint={{ label: c.hintLabel, body: c.blurb }} />
                  <div className="mt-2 flex flex-col gap-0.5">
                    {rows.length === 0
                      ? <Empty>{needle ? "No match here." : c.empty}</Empty>
                      : rows.map((r) => renderRow(r, c.id))}
                  </div>
                </section>
              );
            })}
          </section>

          {/* the heavy/dead lists — collapsed count-headers that expand inline */}
          <section aria-label="Cold ladder and dead lists" className="mt-4 flex flex-col gap-2.5">
            {HEAVY_COLS.map((c) => {
              const rows = shown[c.id];
              const all = columns[c.id];
              const open = openCols.has(c.id) || (!!needle && rows.length > 0);
              const isLadder = c.id === "ladder" || c.id === "finished";
              return (
                <div key={c.id} id={`pipeline-col-${c.id}`}
                  className="vk-pane glass overflow-hidden rounded-pane">
                  <div className="flex items-center">
                    <button onClick={() => toggleCol(c.id)} aria-expanded={open} aria-controls={`body-${c.id}`}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-card px-3.5 py-3 text-left hover:bg-well">
                      <span aria-hidden className="shrink-0 text-ink-dim"><IconChevron open={open} /></span>
                      <span className="shrink-0 text-body font-medium text-ink">{c.label}</span>
                      <Readout className="shrink-0 text-body text-ink">
                        {needle ? `${rows.length} of ${all.length}` : all.length}
                      </Readout>
                      {isLadder && all.length > 0 && (
                        <span aria-hidden className="pips shrink-0" style={{ ["--pip-hue" as string]: c.id === "ladder" ? "var(--st-due)" : "var(--st-idle)" }}>●●●</span>
                      )}
                      <span className="ml-auto min-w-0 truncate pl-2 text-caption text-ink-dim">— {PIPELINE_NOTES[c.blurbKey]}</span>
                    </button>
                    <Hint label={c.hintLabel} className="mr-3.5 shrink-0">{PIPELINE_BLURBS[c.blurbKey]}</Hint>
                  </div>
                  {open && (
                    <div id={`body-${c.id}`} className="border-t border-line px-3.5 pb-3.5 pt-2.5">
                      {/* bulk pause lives ONLY here — the finished expansion (tenet 22) */}
                      {c.id === "finished" && all.length > 0 && (
                        <div className="mb-2 flex items-center gap-3">
                          <button
                            onClick={() => setPicked(picked.size === all.length ? new Set() : new Set(all.map((r) => r.key)))}
                            className="text-caption text-tone-info-ink underline underline-offset-2 hover:brightness-110">
                            {picked.size === all.length ? "Clear selection" : `Select all ${all.length}`}
                          </button>
                          <Action onClick={() => setBulkPause(true)} disabled={picked.size === 0}
                            title="Pause every selected company — reversible any time from the Paused list">
                            {pauseSelectedLabel(picked.size)}
                          </Action>
                        </div>
                      )}
                      <div className="flex flex-col gap-0.5">
                        {rows.length === 0 && <Empty>{needle ? "No match here." : "Nothing here right now."}</Empty>}
                        {c.id === "finished"
                          ? rows.map((r) => (
                            <div key={r.key} className="flex items-center gap-2">
                              <input type="checkbox" checked={picked.has(r.key)} aria-label={`Select ${r.key} for bulk pause`}
                                onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(r.key); else n.delete(r.key); return n; })}
                                className="shrink-0 accent-[var(--accent)]" style={{ width: 15, height: 15 }} />
                              <div className="min-w-0 flex-1">{renderRow(r, c.id)}</div>
                            </div>
                          ))
                          : rows.map((r) => renderRow(r, c.id))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </section>

          {/* footer — what the board deliberately leaves out, labeled per count */}
          <p className="mt-4 border-t border-line pt-2 text-caption text-ink-dim">
            {needle ? `${totalShown} companies match · ` : ""}
            {totalTracked} tracked in total · not shown: {(view.counts.spam ?? 0) + (view.counts.probe ?? 0) + (view.counts.system ?? 0)} junk or automated senders
            {view.counts.dnc ? ` · ${view.counts.dnc} on the do-not-contact list` : ""}
          </p>
        </>
      )}

      {/* drill-down — the conversation + the registry gates for this row */}
      {sel && (
        <Drawer title={sel.key} onClose={() => setSel(null)}>
          <RowDetail row={sel} col={selCol}
            onGate={(action) => setGate({ action, row: sel })}
            onOpenToday={onOpenToday && (
              selCol === "their" || selCol === "yours" || selCol === "meet" ||
              (selCol === "ladder" && (view?.cold_rows.due.some((c) => c.key === sel.key) ?? false))
            ) ? () => { setSel(null); onOpenToday(sel.key); } : undefined} />
        </Drawer>
      )}

      {/* the ONE gate dialog — same words as Today's, by construction */}
      {gate && (
        <GateConfirm action={gate.action} name={gate.row.key}
          onConfirm={(reason) => runGate(gate.action, gate.row, reason)}
          onClose={() => setGate(null)} />
      )}

      {bulkPause && (
        <ConfirmModal
          title={`Pause ${picked.size} compan${picked.size === 1 ? "y" : "ies"}`}
          body={<>Every selected company is paused: off every list, out of every send, until you reactivate it. One reason is recorded on all {picked.size}. Reversible any time from the Paused list.</>}
          reasonLabel="Reason (recorded on every company)"
          confirmLabel={`Pause all ${picked.size}`}
          onConfirm={runBulkPause}
          onClose={() => setBulkPause(false)}
        />
      )}
      <Toaster />
    </div>
  );
}

// ── the drawer: facts, gates, and the full conversation ──────────────────────
function RowDetail({ row, col, onGate, onOpenToday }: {
  row: PRow; col: ColId | null;
  onGate: (a: "freeze" | "unfreeze" | "close" | "dnc") => void;
  onOpenToday?: () => void; // present only when the row has a place on Today
}) {
  const m = row.row?.meta;
  const email = m?.people[0] ?? row.cold?.people[0] ?? "";
  const live = col === "their" || col === "yours" || col === "meet";
  const facts: [string, string][] = [];
  if (email) facts.push(["Contact", m?.people.join(", ") ?? email]);
  const chip = sentRepliesChip(m?.touches ?? row.cold?.touches ?? null, m?.replies_count ?? null);
  if (chip) facts.push(["Mail", chip]);
  if (m?.last_in_date) facts.push(["They last wrote", day(m.last_in_date)]);
  const lastOut = m?.last_out_date ?? row.cold?.last_out_date;
  if (lastOut) facts.push(["We last wrote", day(lastOut)]);
  const quiet = m?.bizdays_since_out ?? row.cold?.bizdays_since_out;
  if (quiet != null) facts.push(["Quiet for", `${quiet} business day${quiet === 1 ? "" : "s"}`]);
  const nextDue = m?.next_due ?? row.cold?.next_due;
  facts.push(["Next touch", nextDue ? `due ${day(nextDue)}` : "none scheduled"]);
  if (m?.frozen_meta?.frozen_on) facts.push(["Paused", pausedLine(m)]);

  return (
    <div className="flex flex-col gap-3 text-body">
      {/* the row's own line, verbatim — the drawer continues the row it came from */}
      <p className="flex items-baseline gap-2 text-caption text-ink-dim">
        <span className="min-w-0 flex-1 truncate">{row.secondary}</span>
        {row.word && <span className="shrink-0 font-medium">{row.word}</span>}
        {row.when && <span className="shrink-0 tabular-nums">{row.when}</span>}
      </p>

      <section aria-label="Where it stands">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {facts.map(([k, v]) => (
            <FactLine key={k} k={k} v={v} />
          ))}
        </div>
      </section>

      <section aria-label="Actions" className="border-t border-line pt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {onOpenToday && <Action variant="primary" onClick={onOpenToday}>Open on Today</Action>}
          {col === "paused" && <Action onClick={() => onGate("unfreeze")}>Reactivate</Action>}
          {(col === "ladder" || col === "finished" || live) && <Action onClick={() => onGate("freeze")}>Pause…</Action>}
          {col === "finished" && <Action variant="danger" onClick={() => onGate("close")}>Close out…</Action>}
          {col === "finished" && email && <Action variant="danger" onClick={() => onGate("dnc")}>Do not contact…</Action>}
        </div>
        <p className="mt-1.5 text-caption text-ink-dim">
          {col === "paused" ? "Reactivating puts this company back on its worklists right away."
            : col === "closed" ? "Closed as declined. It re-opens by itself if they write back with interest."
            : onOpenToday ? "Reply, nudge and send work happens on the Today tab — Open on Today lands with this company already selected."
            : live ? "To reply, nudge or send, open this company on the Today tab — the full drafting tools live there."
            : "Pausing is reversible; closing out and do-not-contact are recorded as final."}
        </p>
      </section>

      {/* the SAME conversation surface Today renders, read-only here */}
      <section aria-label="Conversation" className="border-t border-line pt-2">
        <h3 className="mb-1 text-body font-medium text-ink">Conversation</h3>
        <Conversation rowKey={row.key} />
      </section>
    </div>
  );
}

function FactLine({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="text-caption text-ink-dim">{k}</span>
      <span className="min-w-0 text-body text-ink">{v}</span>
    </>
  );
}
