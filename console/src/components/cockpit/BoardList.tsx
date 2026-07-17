"use client";

import { AssayRow, EyebrowHeader, Pips, cx, type StateHue } from "@/components/kit";
import { IconChevron } from "./icons";
import { holdChip, quietFor } from "./prose";
import type { Board, ColdGroup, ColdPlan, ColdVRow, Sel, View, VRow } from "./types";

// LEFT PANE — V5 (operator redesign 2026-07-10). The rail is the week at a
// glance and nothing else: meetings, then THREE plain lists —
//   They're waiting on you · Waiting on them · Cold outreach due
// Rows read like an inbox (who + what they last said). No counts, no chips,
// no legend, no tallies. State that matters (hold dates, follow-up due — the
// 3-business-day cadence, meeting flags, bounces) rides as ONE quiet word on
// the row; everything else lives in the conversation pane.

// CALIBRATED INSTRUMENT (Phase T, 2026-07-17): each list is an eyebrow section
// (label + mono count = rows, tenet 8) of assay-strip rows. The list carries a
// default state hue; a row overrides it (a bounced row always reads owed).
//   they're waiting on you = owed (red) · waiting on them = idle/meet ·
//   set aside = idle (gray) · cold due = due (amber).
const LISTS: { id: "owe" | "them" | "aside" | "cold"; label: string; hue: StateHue }[] = [
  { id: "owe", label: "They're waiting on you", hue: "owed" },
  { id: "them", label: "Waiting on them", hue: "idle" },
  // set-aside gets its OWN header (operator 2026-07-11, second pass): as a
  // subgroup at the tail of "Waiting on them" it sat below the fold and the
  // operator couldn't find his parked row — a top-level label scans instantly.
  // Hidden entirely when empty, like the other non-owe lists.
  { id: "aside", label: "Set aside until tomorrow", hue: "idle" },
  { id: "cold", label: "Cold outreach due", hue: "due" },
];

// map a row's section (and warn flag) to one of the five state hues for its
// 3px strip. Bounced always reads owed; cadence follow-ups read due; meeting-set
// rows read meet; everything the ball is on them reads idle.
function rowHueFor(sectionId: string, warn: boolean, word: string | null): StateHue {
  if (warn) return "owed";
  if (sectionId === "reply" || sectionId === "look" || sectionId === "contacted") return "owed";
  if (sectionId === "nudge") return "due";
  if (sectionId === "cold") return "due";
  if (word && /meeting|invite/i.test(word)) return "meet";
  if (sectionId === "institutional") return "meet";
  return "idle";
}

// short relative stamp for the row's dedicated top-right time slot —
// "today" / "3d" / "2w" / "Jun 12" (shared with the Pipeline tab)
export function relStamp(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.slice(0, 10) + "T12:00:00");
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 7) return `${days}d`;
  if (days < 28) return `${Math.floor(days / 7)}w`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// the one quiet state word a row is allowed — cadence and directives speak,
// default states stay silent (being in the list already says it).
// Exported: the Pipeline board speaks the SAME vocabulary (ONE DESK port).
export function stateWord(r: VRow, sectionId: string): string | null {
  const m = r.meta;
  if ((m.bounces?.length ?? 0) > 0) return "⚠ bounced";
  if (sectionId === "held") return holdChip(m.hold_until);
  if (sectionId === "personal") return "yours";
  if (m.meeting_state === "rescheduling") return "rescheduling";
  if (m.meeting_state === "outcome-due") return "meeting passed";
  if (m.meeting_state === "scheduled") return m.meeting_invite_sent === false ? "invite not sent" : "meeting set";
  if (sectionId === "nudge") return `follow up — ${quietFor(m.bizdays_since_out)}`;
  if (sectionId === "closeout") return "maybe dead";
  if (sectionId === "institutional") return "bid desk";
  if (sectionId === "look") return "read it";
  if (sectionId === "contacted") return "wrote in first";
  return null;
}

interface ListRow { key: string; primary: string; secondary: string; word: string | null; when: string | null; warn?: boolean; hue: StateHue; sel: Sel }

function rowOf(r: VRow, sectionId: string): ListRow {
  const word = stateWord(r, sectionId);
  const warn = (r.meta.bounces?.length ?? 0) > 0;
  const lastIn = r.meta.last_in_date || "", lastOut = r.meta.last_out_date || "";
  return {
    key: r.key,
    primary: r.key,
    secondary: (r.meta.last_in_gist || r.meta.last_in_from || r.meta.people[0] || "—")
      + (r.meta.company_class === "test" ? " · TEST" : ""),
    word,
    when: relStamp(lastIn > lastOut ? lastIn : lastOut || lastIn),
    warn,
    hue: rowHueFor(sectionId, warn, word),
    sel: { kind: "row", key: r.key, sectionId: sectionId === "look" ? "reply" : sectionId, row: r },
  };
}

export function BoardList({ view, board, selKey, freshKeys, hiddenKeys, asideKeys, open, onToggle, onSelect, onOpenSystem, onCancelMeeting, coldPlan, onSendColdGroup }: {
  view: View; board: Board | null; selKey: string | null;
  freshKeys: { key: string; known: boolean }[];
  hiddenKeys?: Set<string>; // optimistic freeze/close hides pending the engine echo
  asideKeys?: Set<string>;  // set-aside companies — folded into "Waiting on them"
  open: Record<string, boolean>; onToggle: (id: string, next: boolean) => void;
  onSelect: (s: Sel) => void;
  onOpenSystem: () => void;
  onCancelMeeting?: (m: { key: string; eventId: string; inviteSent: boolean }) => void;
  // cold follow-ups are templated — the plan groups them by language × ladder
  // step so a whole group sends off ONE reviewed sample (operator 2026-07-10)
  coldPlan?: ColdPlan | null;
  onSendColdGroup?: (g: ColdGroup) => void;
}) {
  const hidden = (key: string) => hiddenKeys?.has(key) ?? false;
  const aside = (key: string) => asideKeys?.has(key) ?? false;
  const sectionRows = (id: string): VRow[] =>
    (view.sections.find((s) => s.id === id)?.rows ?? []).filter((r) => !hidden(r.key) && !aside(r.key));

  const selectByKey = (key: string) => {
    const pool = [
      ...view.sections.flatMap((s) => s.rows.map((row) => ({ row, sid: s.id }))),
      // frozen-lead-wrote-back rows live outside the sections; opening one shows
      // its conversation the same way (they hold the ball, so treat as "reply").
      ...(view.pinged_rows ?? []).map((row) => ({ row, sid: "reply" })),
    ];
    const hit = pool.find((x) => x.row.key === key);
    if (hit) onSelect({ kind: "row", key, sectionId: hit.sid, row: hit.row });
  };

  // ── the three lists ─────────────────────────────────────────────────────
  // owe: they wrote last, an answer is owed (incl. rows the engine couldn't
  //      auto-read — same obligation, the word "read it" marks them)
  const reply = sectionRows("reply");
  const owe: ListRow[] = [
    ...reply.map((r) => rowOf(r, r.meta.state === "replied-unclassified" ? "look" : "reply")),
    // first-contact senders — people who wrote in without any outreach from us
    // (engine lane "contacted", operator ruling 2026-07-11). Same obligation as
    // an owed reply: read it, then answer or close it out as junk.
    ...sectionRows("contacted").map((r) => rowOf(r, "contacted")),
  ];

  // them: every live thread where the ball is theirs or you parked it —
  // in-flight, follow-up due (cadence!), held, yours, suggested close-outs,
  // bid desk, set-asides, plus today's fresh adds. Nothing vanishes.
  const them: ListRow[] = [
    ...sectionRows("nudge").map((r) => rowOf(r, "nudge")),
    ...sectionRows("inflight").map((r) => rowOf(r, "inflight")),
    ...sectionRows("personal").map((r) => rowOf(r, "personal")),
    ...sectionRows("held").map((r) => rowOf(r, "held")),
    ...sectionRows("closeout").map((r) => rowOf(r, "closeout")),
    ...sectionRows("institutional").map((r) => rowOf(r, "institutional")),
    ...freshKeys.filter((f) => !hidden(f.key) && !aside(f.key)).map((f) => ({
      key: f.key, primary: f.key,
      secondary: f.known ? "decided today" : "new lead added today",
      word: board?.journeys[f.key]?.drafted ? "drafted" : "awaiting draft",
      when: "today",
      hue: "idle" as const,
      sel: { kind: "fresh" as const, key: f.key, known: f.known },
    })),
  ];

  const cold: ListRow[] = view.cold_rows.due
    .filter((c) => !hidden(c.key) && !aside(c.key))
    .map((c: ColdVRow) => ({
      key: c.key, primary: c.key,
      secondary: c.contact || "no named contact",
      word: `touch ${c.touches + 1} of 3 due`,
      when: relStamp(c.last_out_date),
      hue: "due" as const,
      sel: { kind: "cold" as const, key: c.key, cold: c },
    }));

  // set-aside rows = their own top-level rail group (operator 2026-07-11: the
  // parked row must be findable at a glance and rescuable the same day —
  // open it and the pane offers "Bring back today"). Word stays quiet: the
  // header already says what the group is.
  const asideRows: ListRow[] = view.sections.flatMap((s) => s.rows)
    .filter((r) => aside(r.key) && !hidden(r.key))
    .map((r) => ({ ...rowOf(r, "aside"), word: "back tomorrow", hue: "idle" as const, sel: { kind: "row" as const, key: r.key, sectionId: "aside", row: r } }));

  const listRows: Record<string, ListRow[]> = { owe, them, aside: asideRows, cold };

  // cold, pre-grouped: each plan group is ONE template — rows sort under their
  // group's header, which carries the send-all control. Rows the plan can't
  // batch (no earlier email on file, test addresses) stay visible below with
  // the reason as their state word — nothing vanishes.
  const coldByKey = new Map(cold.map((r) => [r.key, r]));
  const coldGroups = (coldPlan?.groups ?? [])
    .map((g) => ({ group: g, rows: g.companies.map((c) => coldByKey.get(c.domain)).filter(Boolean) as ListRow[] }))
    .filter((x) => x.rows.length > 0);
  const groupedColdKeys = new Set(coldGroups.flatMap((x) => x.rows.map((r) => r.key)));
  const coldLoose: ListRow[] = cold
    .filter((r) => !groupedColdKeys.has(r.key))
    .map((r) => ({
      ...r,
      word: coldPlan?.unresolved_no_send_on_record.includes(r.key) ? "no earlier email on file"
        : coldPlan?.dropped_noise.includes(r.key) ? "test address"
        : coldPlan?.skipped_dnc?.includes(r.key) ? "address dead or do-not-contact — will not be emailed"
        : r.word,
    }));

  // Frozen leads that wrote back — the freeze stays on, but a fresh reply must
  // never sit invisible (the acme-labs.example.com fix, 2026-07-14). Loudest card on the rail.
  const pinged = (view.pinged_rows ?? []).filter((r) => !hidden(r.key));

  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-2">
      {/* Frozen leads that wrote back — surfaced above everything */}
      {pinged.length > 0 && (
        <div className="vk-card mb-2 rounded-card border border-tone-warn/50 bg-tone-warn/10 px-3 py-2">
          <h2 className="mb-1 text-caption font-medium text-tone-warn-ink">
            {pinged.length === 1 ? "A frozen lead wrote back" : "Frozen leads wrote back"}
          </h2>
          {pinged.map((r) => (
            <button key={r.key} onClick={() => selectByKey(r.key)}
              title="Open this conversation — the freeze stays on until you lift it"
              className="group flex w-full items-baseline gap-2 rounded-ctl px-1.5 py-1 text-left hover:bg-fill-2">
              <span className="min-w-0 truncate text-body font-medium text-ink">{r.key}</span>
              <span className="min-w-0 flex-1 truncate text-caption text-ink-dim">
                {r.meta.last_in_gist || r.cells.last_in}
              </span>
              <span className="shrink-0 text-caption text-tone-warn-ink">still frozen — open to reply or keep frozen</span>
            </button>
          ))}
        </div>
      )}

      {/* Meetings — the week's fixed points, always on top */}
      {view.meetings.length > 0 && (
        <div className="vk-card mb-2 rounded-card border border-line bg-fill-1 px-3 py-2">
          <EyebrowHeader className="mb-1" label="Meetings" count={view.meetings.length} />
          {view.meetings.map((m) => {
            const when = m.at
              ? new Date(m.at + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
              : null;
            const status = m.state === "rescheduling" ? "rescheduling — new date pending"
              : m.state === "outcome-due" ? "date passed — log the outcome"
              : m.invite_sent === false ? "invite not sent yet"
              : m.invite_sent ? "invite sent ✓" : "on the calendar";
            const warn = m.state !== "scheduled" || m.invite_sent === false;
            return (
              <div key={m.key} className="group flex w-full items-center gap-2 rounded-ctl px-1.5 py-1 hover:bg-fill-2">
                <button onClick={() => selectByKey(m.key)} title="Open this company's conversation"
                  className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
                  {when && <span className="shrink-0 text-body font-medium text-ink">{when}</span>}
                  <span className="min-w-0 truncate text-body text-ink">{m.key}</span>
                  <span className={cx("shrink-0 text-caption", warn ? "font-medium text-tone-warn-ink" : "text-tone-ok-ink")}>{status}</span>
                </button>
                {m.meet_url && (
                  <a href={m.meet_url} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}
                    title="Open the Google Meet call"
                    className="shrink-0 rounded-ctl border border-tone-info/45 px-2 py-0.5 text-caption text-tone-info-ink hover:bg-tone-info/10">
                    Meet ↗
                  </a>
                )}
                {m.event_id && onCancelMeeting && m.state !== "outcome-due" && (
                  <button onClick={(ev) => { ev.stopPropagation(); onCancelMeeting({ key: m.key, eventId: m.event_id!, inviteSent: !!m.invite_sent }); }}
                    title="Cancel this meeting on the calendar"
                    className="shrink-0 rounded-ctl border border-tone-bad/40 px-2 py-0.5 text-caption text-tone-bad-ink opacity-0 hover:bg-tone-bad/10 group-hover:opacity-100 focus-visible:opacity-100">
                    Cancel
                  </button>
                )}
                <span aria-hidden className="shrink-0 text-ink-dim opacity-0 group-hover:opacity-100"><IconChevron open={false} /></span>
              </div>
            );
          })}
        </div>
      )}

      {LISTS.map((g) => {
        const rows = listRows[g.id];
        if (rows.length === 0 && g.id !== "owe") return null;
        return (
          <div key={g.id} id={`board-group-${g.id}`} className="mb-2.5"
            {...(g.id === "aside" ? { "data-aside-group": true } : {})}
            {...(g.id === "aside" ? { title: "Back on its own list in the morning — open one and choose Bring back today to rescue it now" } : {})}>
            {/* section header = eyebrow: label + mono count (count = rows, tenet 8) */}
            <EyebrowHeader className="mb-0.5 px-1" label={g.label} count={rows.length} />
            {rows.length === 0 && g.id === "owe" && (
              <p className="px-2 py-1 text-body text-ink-dim">Nobody is waiting on you. ✓</p>
            )}
            {(() => {
              // the rail row is the assay strip (Phase T): 3px state hue · domain
              // · one chip (the state word) · mono age; the gist reveals on hover.
              const renderRow = (r: ListRow) => (
                <AssayRow key={r.key} name={r.primary} hue={r.hue}
                  chip={r.word} chipHue={r.warn ? "owed" : r.hue} when={r.when} gist={r.secondary}
                  selected={selKey === r.key} onClick={() => onSelect(r.sel)} />
              );
              // cold pre-groups when the plan is in: each group = one template,
              // its header carries ladder pips + the send-all control (operator 2026-07-10)
              if (g.id === "cold" && coldGroups.length > 0) {
                return (
                  <>
                    {coldGroups.map(({ group: cg, rows: crows }) => {
                      const step = cg.step === "cold-03" ? 3 : 2;
                      return (
                        <div key={`${cg.lang}-${cg.step}`} className="mb-1" data-cold-group={`${cg.lang}-${cg.step}`}>
                          <div className="flex items-center gap-2 px-2 pb-0.5 pt-1">
                            <Pips done={step} total={3} hue="due" label={`${cg.label} — touch ${step} of 3`} />
                            <span className="min-w-0 flex-1 truncate text-caption font-medium text-ink-dim">
                              {cg.label} — same email to all {crows.length}
                            </span>
                            {onSendColdGroup && (
                              <button onClick={() => onSendColdGroup(cg)}
                                title={`Review one sample of this follow-up, then send it to all ${crows.length} at once`}
                                className="shrink-0 rounded-ctl border border-tone-warn/50 px-2 py-0.5 text-caption font-medium text-tone-warn-ink hover:bg-tone-warn/10">
                                Send all {crows.length}…
                              </button>
                            )}
                          </div>
                          {crows.map(renderRow)}
                        </div>
                      );
                    })}
                    {coldLoose.length > 0 && (
                      <div className="mb-1">
                        <div className="px-2 pb-0.5 pt-1 text-caption text-ink-dim">One at a time — these can&apos;t join a group</div>
                        {coldLoose.map(renderRow)}
                      </div>
                    )}
                  </>
                );
              }
              return rows.map(renderRow);
            })()}
          </div>
        );
      })}

      <div className="mt-2 border-t border-line px-2 pt-2">
        <button onClick={onOpenSystem} className="text-caption text-tone-info-ink underline underline-offset-2 hover:brightness-110">
          System status →
        </button>
      </div>
    </div>
  );
}
