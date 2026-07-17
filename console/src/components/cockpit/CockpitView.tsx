"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Action, ConfirmModal, Drawer, Modal, Toaster, cx, toast } from "@/components/kit";
import { pollJob } from "@/lib/pollJob";
import { useBoard } from "@/lib/useBoard";
import { detectLang, insertTerms } from "@/lib/salesTerms";
import { AttachPicker } from "./AttachPicker";
import { BoardList } from "./BoardList";
import { FreshModal } from "./FreshModal";
import { GATE_DONE_WORD, GateConfirm } from "./GateConfirm";
import { GroupSendModal } from "./GroupSendModal";
import { HoldModal } from "./HoldModal";
import { HouseFormat } from "./HouseFormat";
import { MeetingForm } from "./MeetingForm";
import { holdDay } from "./prose";
import { ToPicker } from "./PackPreview";
import { PacksList } from "./PacksList";
import { SendModal } from "./SendModal";
import { SystemPanel } from "./SystemPanel";
import { ThreadPane } from "./ThreadPane";
import { TopBar } from "./TopBar";
import type { Board, ColdGroup, ColdPlan, DirectiveAction, GateAction, Mtimes, Pack, Sel, SQ, VRow } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// THE COCKPIT — ground-up rebuild #2, 2026-07-03 (accessibility & clarity
// audit on top of the parity spine).
//
// One screen answers ONE question: "who needs a reply, and what do I send?"
//
//   LEFT  — the prioritized company list (BoardList) in /inbox-check spine
//           order. Section headers announce their real names; operator notes
//           are text chips; the active pipeline filter is always escapable.
//   RIGHT — the full conversation (ThreadPane), then decision support in
//           authority order: operator notes → engine next step → AI advisory.
//           ONE draft card with ONE staging control.
//
// DATA RULE (parity): every classification and every recommendation string
// comes VERBATIM from the canonical view (/api/board ← build_view(), the same
// object /inbox-check prints). board-view v2 adds action_parts so provenance
// renders distinctly — same content, structured, never re-derived here.
//
// OVERLAY RULE: every menu, drawer and dialog closes on Escape AND on outside
// click, returns focus to its trigger, and sits on an OPAQUE surface. The kit
// (Menu / Drawer / Modal) owns this; the cockpit never hand-rolls an overlay.
// ─────────────────────────────────────────────────────────────────────────────

export function CockpitView({ focusKey, onFocusConsumed, sendFile, onSendFileConsumed }: {
  // ONE DESK port: Pipeline's "Open on Today" lands here with the row preselected
  focusKey?: string | null;
  onFocusConsumed?: () => void;
  // Task tray hand-off: a staged-but-unsent pack lands here with its guarded
  // send confirm open (checks already passed; sending still needs the confirm)
  sendFile?: string | null;
  onSendFileConsumed?: () => void;
} = {}) {
  // the shared board feed — same fetch + optimistic-hide contract as Pipeline
  const { board, setBoard, view, err: boardErr, loading: boardLoading, hidden: hiddenKeys, hide, load, mtimes: loadedMtimes } = useBoard();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [sq, setSq] = useState<SQ | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({}); // group open/closed
  const [newMail, setNewMail] = useState(false);
  const [working, setWorking] = useState<Record<string, string>>({});
  const [drawer, setDrawer] = useState<"packs" | "system" | null>(null);
  const [freshOpen, setFreshOpen] = useState(false);
  const [showFormat, setShowFormat] = useState(false);
  const [attach, setAttach] = useState<{ file: string; entryIndex: number; current: string[] } | null>(null);
  // pre-draft attachment picks, per company — they ride the next draft run for
  // that key (validated + applied server-side) and clear once it lands
  const [pendingAttach, setPendingAttach] = useState<Record<string, string[]>>({});
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ file: string; entry: number; subject: string; body: string; to: string; toEmail: string } | null>(null);
  const editBodyRef = useRef<HTMLTextAreaElement>(null);
  const [sendPack, setSendPack] = useState<Pack | null>(null);
  const [meetingFor, setMeetingFor] = useState<{ domain: string; who: string; people: string[] } | null>(null);
  const [gate, setGate] = useState<{ action: GateAction; key: string; people: string[] } | null>(null);
  const [cancelMeetingFor, setCancelMeetingFor] = useState<{ key: string; eventId: string; inviteSent: boolean } | null>(null);
  const [askInfoFor, setAskInfoFor] = useState<string | null>(null);
  // V4.2 operator directives + the per-company command box
  const [directive, setDirective] = useState<{ action: DirectiveAction; key: string } | null>(null);
  const [instructing, setInstructing] = useState<Record<string, string>>({});
  const [proposal, setProposal] = useState<{ key: string; action: "hold" | "personal"; until?: string; reason?: string } | null>(null);
  const [agentAnswer, setAgentAnswer] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => { fetch("/api/send-queue").then((r) => r.json()).then(setSq).catch(() => {}); }, [packs]);

  // cold group plan — how the "Cold outreach due" list pre-groups (one template
  // per language × ladder step). Re-fetched per board build; the route caches
  // by board mtime, so this is cheap. No plan → the list renders flat (honest).
  const [coldPlan, setColdPlan] = useState<ColdPlan | null>(null);
  const [coldGroup, setColdGroup] = useState<ColdGroup | null>(null);
  const boardRanAt = board?.ranAt ?? 0;
  const coldDueCount = board?.view.cold_rows.due.length ?? 0;
  useEffect(() => {
    if (coldDueCount === 0) { setColdPlan(null); return; }
    let dead = false;
    fetch("/api/cold-batch").then((r) => (r.ok ? r.json() : null))
      .then((p) => { if (!dead) setColdPlan(p && !p.error ? p as ColdPlan : null); })
      .catch(() => { if (!dead) setColdPlan(null); });
    return () => { dead = true; };
  }, [boardRanAt, coldDueCount]);

  const loadBoard = useCallback((opts?: { force?: boolean }) => {
    setNewMail(false);
    load(opts);
  }, [load]);
  const loadPacks = useCallback(() => {
    fetch("/api/drafts").then((r) => r.json()).then((d) => setPacks(d.packs ?? [])).catch(() => {});
  }, []);
  useEffect(() => { loadBoard(); loadPacks(); }, [loadBoard, loadPacks]);

  // new-mail watch — local file mtimes only, every 30s
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const d = await fetch("/api/board?head=1").then((r) => r.json()) as { mtimes: Mtimes };
        const seen = loadedMtimes.current;
        if (!seen) return;
        // board.json counts too — a rebuild outside the console (CLI /inbox-check)
        // must raise the banner just like new mail or activity would.
        if (d.mtimes.corpus > seen.corpus || d.mtimes.activity > seen.activity || d.mtimes.board > seen.board) setNewMail(true);
        if (d.mtimes.drafts > seen.drafts) { loadPacks(); loadedMtimes.current = { ...seen, drafts: d.mtimes.drafts }; }
      } catch { /* transient */ }
    }, 30_000);
    return () => clearInterval(t);
  }, [loadPacks]);

  const today = view?.meta.today ?? new Date().toISOString().slice(0, 10);

  const sectionRows = useCallback((id: string): VRow[] =>
    (view?.sections.find((s) => s.id === id)?.rows ?? []).filter((r) => !hiddenKeys.has(r.key)), [view, hiddenKeys]);

  // fresh picks = today's decisions for keys with no board row (write-layer)
  const freshKeys = useMemo(() => {
    if (!board || !view) return [] as { key: string; known: boolean }[];
    const rowKeys = new Set<string>();
    for (const s of view.sections) for (const r of s.rows) rowKeys.add(r.key);
    for (const c of view.cold_rows.due) rowKeys.add(c.key);
    const onBoard = new Set(view.keys);
    return Object.entries(board.decisions)
      .filter(([k, d]) => !rowKeys.has(k) && d.decision !== "clear")
      .map(([k]) => ({ key: k, known: onBoard.has(k) }));
  }, [board, view]);

  // the day's pipeline meter — one KPI strip, also the list filter
  const allItems = useMemo(() => {
    if (!view) return [] as string[];
    const keys: string[] = [];
    for (const id of ["reply", "nudge", "closeout", "inflight"]) for (const r of sectionRows(id)) keys.push(r.key);
    for (const c of view.cold_rows.due) keys.push(c.key);
    for (const f of freshKeys) keys.push(f.key);
    return [...new Set(keys)].filter((k) => !hiddenKeys.has(k));
  }, [view, sectionRows, freshKeys, hiddenKeys]);

  // set-aside is a real, visible, reversible state: these keys move into their
  // own board group (BoardList "aside"), never silently vanish (V4.1 Phase 9)
  const asideKeys = useMemo(() => {
    const s = new Set<string>();
    for (const [k, d] of Object.entries(board?.decisions ?? {})) if (d.decision === "skip") s.add(k);
    return s;
  }, [board]);

  const draftables = useMemo(() =>
    allItems.filter((k) => {
      const d = board?.decisions[k]?.decision;
      return (d === "reply" || d === "include") && !board?.journeys[k]?.drafted;
    }), [allItems, board]);

  // a hand-off from Pipeline ("Open on Today") preselects its company — any
  // section or the cold-due list. If the engine moved it meanwhile, land
  // unselected rather than on the wrong row (honest miss).
  useEffect(() => {
    if (!view || !focusKey) return;
    for (const s of view.sections) {
      const r = s.rows.find((x) => x.key === focusKey);
      if (r) { setSel({ kind: "row", key: focusKey, sectionId: s.id, row: r }); onFocusConsumed?.(); return; }
    }
    const c = view.cold_rows.due.find((x) => x.key === focusKey);
    if (c) setSel({ kind: "cold", key: focusKey, cold: c });
    onFocusConsumed?.();
  }, [view, focusKey, onFocusConsumed]);

  // auto-select the most urgent row once the board lands (a pending hand-off
  // from Pipeline wins — it selects in the effect above)
  useEffect(() => {
    if (!view || sel || focusKey) return;
    const first = sectionRows("reply")[0] ?? sectionRows("nudge")[0] ?? sectionRows("inflight")[0];
    if (first) setSel({ kind: "row", key: first.key, sectionId: sectionRows("reply")[0] ? "reply" : sectionRows("nudge")[0] ? "nudge" : "inflight", row: first });
  }, [view, sel, focusKey, sectionRows]);

  // keep the selected row's data fresh across board reloads
  useEffect(() => {
    if (!view || !sel || sel.kind !== "row") return;
    for (const s of view.sections) {
      const r = s.rows.find((x) => x.key === sel.key);
      if (r) { if (r !== sel.row) setSel({ kind: "row", key: r.key, sectionId: s.id, row: r }); return; }
    }
  }, [view, sel]);

  // ── write-layer actions ───────────────────────────────────────────────────
  const decide = async (key: string, decision: string) => {
    setBoard((b) => b ? { ...b, decisions: { ...b.decisions, [key]: { decision, ts: new Date().toISOString(), note: decision } } } : b);
    const res = await fetch("/api/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain: key, decision }) });
    if (!res.ok) { toast(`Couldn't record the decision for ${key}`, { tone: "bad" }); loadBoard(); }
    else if (loadedMtimes.current) loadedMtimes.current = { ...loadedMtimes.current, activity: Date.now() };
  };

  const runWorkbench = async (key: string, body: Record<string, unknown>, startMsg: string, doneMsg: string) => {
    if (working[key]) return;
    const res = await fetch("/api/workbench", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json();
    if (!d.jobId) { toast(`Couldn't start: ${d.error ?? "error"}`, { tone: "bad" }); return; }
    setWorking((w) => ({ ...w, [key]: d.jobId }));
    toast(startMsg, { tone: "info" });
    pollJob(d.jobId, (ok, out) => {
      setWorking((w) => { const n = { ...w }; delete n[key]; return n; });
      if (ok) { toast(doneMsg, { tone: "ok" }); loadPacks(); loadBoard(); return; }
      // an agent may DECLINE to draft (junk mail, nothing to reply to) — that
      // decision must reach the operator, never a false "ready" or a bare
      // "failed" (2026-07-11: refusal on a troll mail surfaced as nothing)
      const noDraft = out.match(/NO_DRAFT:\s*(.+)/);
      if (noDraft) toast(`No draft written for ${key} — ${noDraft[1].trim()}`, { tone: "warn", ttl: 20_000 });
      else toast("The agent run failed — nothing was written.", { tone: "bad" });
    });
  };

  // consume the company's pre-draft attachment picks into a workbench body;
  // they clear optimistically (the run now owns them — the draft card's chips
  // take over as the visible truth once the pack lands)
  const takePicks = (key: string): Record<string, unknown> => {
    const picks = pendingAttach[key] ?? [];
    if (picks.length) setPendingAttach((p) => { const n = { ...p }; delete n[key]; return n; });
    return picks.length ? { attachments: picks } : {};
  };

  const draftReply = (key: string) => {
    if (!board?.decisions[key]) decide(key, "reply");
    runWorkbench(key, { action: "draft-row", domain: key, ...takePicks(key) },
      `Drafting a reply for ${key}…`, `Draft ready for ${key}`);
  };
  const investigate = (key: string) => runWorkbench(key, { action: "investigate", domain: key },
    `Reading ${key}'s thread for facts…`, `Notes updated for ${key}`);
  const draftTheDay = () => runWorkbench("__day__", { action: "draft-day", domains: draftables },
    `Drafting ${draftables.length} item${draftables.length !== 1 ? "s" : ""}…`, "Today's pack is ready — open Drafts to review");

  // "Nudge now" = the same draft-row run, steered to the operator-approved
  // warm-nudge format (the gold-standard example the drafter must read first).
  const NUDGE_INSTRUCTION =
    "This is a WARM NUDGE on a quiet thread — not a full reply. FIRST read the gold-standard example and follow it exactly: " +
    "/opt/velab/vault/reference/draft-examples/lab-distributor-latam__es__warm-nudge.md. " +
    "Format: 3 micro-paragraphs — gender-correct FIRST-NAME greeting (Estimado/a <Nombre>:), " +
    "ONE courtesy line adapted to what they actually last said, ONE light ask sentence — then close with \"Un cordial saludo,\" " +
    "and the house signature. No context rebuild, no time-boxing, no file pushing, one idea per paragraph.";
  const nudgeNow = (key: string) => {
    if (!board?.decisions[key]) decide(key, "reply");
    // suggest:false — a nudge never pushes files; explicit operator picks still ride
    runWorkbench(key, { action: "draft-row", domain: key, instruction: NUDGE_INSTRUCTION, suggest: false, ...takePicks(key) },
      `Writing a light nudge for ${key}…`, `Nudge draft ready for ${key} — review it in the reply card`);
  };

  // ── V4.2 operator directives (hold-until / handling-personally) ───────────
  const runDirective = async (action: DirectiveAction, key: string, opts?: { until?: string; reason?: string }) => {
    setDirective(null); setProposal(null);
    const res = await fetch("/api/directive", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action, until: opts?.until, reason: opts?.reason }),
    });
    const d = await res.json().catch(() => ({} as { error?: string; already?: boolean; until?: string }));
    if (!res.ok) { toast(`Couldn't save that for ${key}: ${d.error ?? "error"}`, { tone: "bad" }); return; }
    if (d.already) {
      toast(action === "hold" ? `${key} is already on hold to that date`
        : action === "personal" ? `${key} is already in your hands`
        : `${key} wasn't ${action === "unhold" ? "on hold" : "in your hands"} — nothing to undo`, { tone: "info" });
    } else {
      toast(action === "hold" ? `${key} on hold — back ${holdDay(opts?.until ?? "")}, sooner if they reply`
        : action === "unhold" ? `${key} is back on its worklists`
        : action === "personal" ? `${key} is in your hands — no more suggested follow-ups`
        : `${key} handed back — the normal follow-up rhythm resumes`, { tone: "ok" });
    }
    loadBoard({ force: true });
  };

  // "Confirm meeting" = one packaged instruct run: the agent parses the slot
  // the client proposed in the thread, HOLDS it on the calendar (nobody
  // notified), and drafts the confirm reply with the Meet link embedded — one
  // review card; the invite fires only at the approved send (2026-07-16 GO).
  const CONFIRM_MEETING_INSTRUCTION =
    "CONFIRM THE MEETING TIME the client proposed in this thread. " +
    "1) Find the concrete slot they proposed in the conversation above (convert to America/Chicago; "
    + "compute from their stated timezone if they gave one). If NO concrete slot exists, create nothing " +
    "and return OPERATOR_RESULT answer explaining what they actually said about timing. " +
    "2) HOLD the slot per your meeting rule (create_meeting.py create — their email plus sales@example.com, 30 minutes). " +
    "3) Write the ONE-entry confirm reply pack in their language: confirm the time plainly, include the " +
    "meet_url in the body where it reads naturally, and set \"_meet_event_id\" on the entry. " +
    "Keep it short — this is a confirmation, not a pitch.";
  const confirmMeeting = (key: string) => runInstruct(key, CONFIRM_MEETING_INSTRUCTION);

  // ── V4.2 command box: ONE agent run scoped to ONE company. Submitting is
  // the opt-in click — no second confirm popup (operator 2026-07-12; console-
  // fired runs are innately approved, hard directive 2026-07-11). ────────────
  const runInstruct = async (key: string, instruction: string) => {
    if (instructing[key]) return;
    const res = await fetch("/api/workbench", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "operator-instruct", key, instruction, ...takePicks(key) }),
    });
    const d = await res.json();
    if (!d.jobId) { toast(`Couldn't start: ${d.error ?? "error"}`, { tone: "bad" }); return; }
    setInstructing((w) => ({ ...w, [key]: d.jobId }));
    pollJob(d.jobId, (ok, out) => {
      setInstructing((w) => { const n = { ...w }; delete n[key]; return n; });
      if (!ok) { toast("The agent run failed — nothing was written.", { tone: "bad" }); return; }
      // the run's last OPERATOR_RESULT line says what came back
      const hits = [...out.matchAll(/OPERATOR_RESULT\s*(\{[^\n]*\})/g)];
      let r: { type?: string; action?: string; until?: string; reason?: string; text?: string } = {};
      try { r = hits.length ? JSON.parse(hits[hits.length - 1][1]) : {}; } catch { /* fall through to generic */ }
      if (r.type === "directive" && r.action === "hold" && /^\d{4}-\d{2}-\d{2}$/.test(r.until ?? "")) {
        setProposal({ key, action: "hold", until: r.until, reason: r.reason });
      } else if (r.type === "directive" && r.action === "personal") {
        setProposal({ key, action: "personal", reason: r.reason });
      } else if (r.type === "answer" && r.text) {
        setAgentAnswer({ key, text: r.text });
      } else if (r.type === "draft") {
        toast(`The agent wrote a draft for ${key} — it's in the reply card`, { tone: "ok" });
      } else {
        toast(`Agent finished for ${key} — check the reply card and notes`, { tone: "ok" });
      }
      loadPacks(); loadBoard();
    });
  };

  const runGate = async (g: { action: GateAction; key: string; people: string[] }, reason: string) => {
    setGate(null);
    const body: Record<string, unknown> = { action: g.action, reason, domain: g.key, company: g.key };
    if (g.action === "dnc") body.email = g.people[0] ?? (g.key.includes("@") ? g.key : "");
    const res = await fetch("/api/gating", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) {
      if (g.action === "unfreeze") {
        toast(`${g.key} — ${GATE_DONE_WORD.unfreeze}`, { tone: "ok" });
      } else {
        toast(`${g.key} — ${GATE_DONE_WORD[g.action]}`, { tone: g.action === "freeze" ? "info" : "warn" });
        if (sel?.key === g.key) setSel(null);
        hide(g.key); // registry write landed — hide now, engine echo follows
      }
      loadBoard({ force: true });
    }
    else toast(`${g.action} failed: ${(await res.json()).error ?? "error"}`, { tone: "bad" });
  };

  const runCancelMeeting = async (m: { key: string; eventId: string }) => {
    setCancelMeetingFor(null);
    const res = await fetch("/api/meeting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", eventId: m.eventId }) });
    const d = await res.json();
    if (d.ok) { toast(`${m.key} — meeting cancelled on the calendar`, { tone: "warn" }); loadBoard({ force: true }); }
    else toast(`Couldn't cancel the meeting: ${d.error ?? "error"}`, { tone: "bad" });
  };

  // V5 Send from the draft card: the card already ensured a staged pack (its
  // Send runs the gate chain first); here we just open the guarded confirm for
  // the right pack. A freshly-staged pack may not be in `packs` yet — fetch.
  const sendDraft = async (file: string) => {
    let p = packs.find((x) => x.file === file);
    if (!p) {
      const d = await fetch("/api/drafts").then((r) => r.json()).catch(() => null) as { packs?: Pack[] } | null;
      p = d?.packs?.find((x) => x.file === file);
      if (d?.packs) setPacks(d.packs);
    }
    if (!p) { toast("That draft moved — it was probably reorganized. Open the lead again.", { tone: "warn" }); loadPacks(); loadBoard(); return; }
    setSendPack(p);
  };

  // task-tray hand-off: open the guarded send confirm for a staged pack
  useEffect(() => {
    if (!sendFile) return;
    onSendFileConsumed?.();
    sendDraft(sendFile);
    // sendDraft is recreated per render; the hand-off consumes on first sight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendFile]);

  const saveEdit = async () => {
    if (!editDraft) return;
    const changedTo = editDraft.toEmail && editDraft.toEmail !== editDraft.to;
    const res = await fetch("/api/drafts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: editDraft.file, entry: editDraft.entry, subject: editDraft.subject, body: editDraft.body,
        original_to: editDraft.to, // recipient beats a stale index if the pack was reorganized
        ...(changedTo ? { to_email: editDraft.toEmail, to_name: "" } : {}),
      }),
    });
    if (res.ok) { toast(changedTo ? `Draft re-addressed to ${editDraft.toEmail} — re-stage before sending` : "Draft updated — re-stage before sending", { tone: "ok" }); setEditDraft(null); loadPacks(); loadBoard(); }
    else toast(`Edit failed: ${(await res.json()).error ?? "error"}`, { tone: "bad" });
  };

  // ── render ────────────────────────────────────────────────────────────────
  if (showFormat) {
    return (
      <div className="thin-scroll h-full overflow-y-auto">
        <div className="mx-auto max-w-[1040px] p-4">
          <button onClick={() => setShowFormat(false)} className="mb-2 text-body text-ink-dim hover:text-ink">← Back to the cockpit</button>
          <HouseFormat header={<h1 className="mb-1 text-title font-medium text-ink">Email format — how outgoing mail looks</h1>} />
        </div>
      </div>
    );
  }

  // the loudest number = answers OWED (reply + first-contact senders — the
  // same rows the "They're waiting on you" list shows; set-aside excluded).
  // count = filter (tenet 8): this number must equal that list's rows.
  const needReply = [...sectionRows("reply"), ...sectionRows("contacted")]
    .filter((r) => !asideKeys.has(r.key)).length;
  const stagedPacks = packs.filter((p) => p.staged && !p.sent).length;

  return (
    <div className="flex h-full flex-col">
      <TopBar
        today={today} needReply={needReply}
        onJumpToOwed={() => {
          setOpen((o) => ({ ...o, reply: true, look: true }));
          setTimeout(() => document.getElementById("board-group-owe")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
        }}
        sq={sq} view={view} dayBusy={!!working["__day__"]} draftables={draftables.length}
        onDraftDay={draftTheDay} stagedPacks={stagedPacks}
        onOpenDrafts={() => setDrawer("packs")} onOpenLeads={() => setFreshOpen(true)}
        onOpenFormat={() => setShowFormat(true)} onRefresh={() => { loadBoard(); loadPacks(); }}
        onOpenSystem={() => setDrawer("system")}
        newMail={newMail} onReload={() => loadBoard()} boardLoading={boardLoading}
      />

      {/* ── the two panes ── */}
      <div className="mx-auto grid min-h-0 w-full max-w-[1440px] flex-1 gap-3 px-4 pb-4 pt-3 md:grid-cols-[380px_minmax(0,1fr)]">
        {/* LEFT — the prioritized list */}
        <section aria-label="Companies by priority"
          className={cx("vk-pane glass min-h-0 flex-col overflow-hidden rounded-pane", sel ? "hidden md:flex" : "flex")}>
          {boardErr && <div className="p-2"><ErrorRetry onRetry={loadBoard} /></div>}
          {boardLoading && !board && <div className="p-2"><LoadingRows /></div>}
          {view && (
            <BoardList
              view={view} board={board} selKey={sel?.key ?? null}
              freshKeys={freshKeys} hiddenKeys={hiddenKeys} asideKeys={asideKeys} open={open}
              onToggle={(id, next) => setOpen((o) => ({ ...o, [id]: next }))}
              onSelect={setSel}
              onOpenSystem={() => setDrawer("system")}
              onCancelMeeting={setCancelMeetingFor}
              coldPlan={coldPlan}
              onSendColdGroup={setColdGroup}
            />
          )}
        </section>

        {/* RIGHT — the selected conversation */}
        <section aria-label="Conversation" className={cx("vk-pane glass min-h-0 flex-col overflow-hidden rounded-pane", sel ? "flex" : "hidden md:flex")}>
          {!sel ? (
            <div className="grid h-full place-items-center p-8 text-center text-body text-ink-dim">
              Pick a company on the left — its full conversation opens here.
            </div>
          ) : (
            <ThreadPane key={sel.key} sel={sel} board={board} busy={working[sel.key]}
              instructBusy={!!instructing[sel.key]} today={today}
              closeSuggestion={view?.proposed_closes.items.find((i) => i.key === sel.key) ?? null}
              onBack={() => setSel(null)}
              onDraft={() => draftReply(sel.key)}
              onNudge={() => nudgeNow(sel.key)}
              onDirective={(action) => setDirective({ action, key: sel.key })}
              onInstruct={(instruction) => runInstruct(sel.key, instruction)}
              onSkip={() => {
                if (board?.decisions[sel.key]?.decision === "skip") { toast(`${sel.key} is already set aside — it returns tomorrow`, { tone: "info" }); return; }
                const key = sel.key;
                decide(key, "skip");
                // undoable for a long beat (operator 2026-07-11): the toast holds
                // 20s with a real Undo; after that the row still lives under
                // "Waiting on them → Set aside until tomorrow"
                toast(`${key} set aside — now in the "Set aside until tomorrow" list`, {
                  tone: "info", ttl: 20_000,
                  action: { label: "Undo", run: () => { decide(key, "clear"); toast(`${key} is back on its worklists`, { tone: "ok" }); } },
                });
              }}
              onUnskip={() => { decide(sel.key, "clear"); toast(`${sel.key} is back on its worklists`, { tone: "ok" }); }}
              onAskInfo={() => setAskInfoFor(sel.key)}
              onMeet={() => {
                const r = sel.kind === "row" ? sel.row : null;
                setMeetingFor({ domain: sel.key, who: r?.meta.last_in_from ?? "", people: r?.meta.people ?? (sel.kind === "cold" ? sel.cold.people : []) });
              }}
              pendingAttachments={pendingAttach[sel.key] ?? []}
              onPickAttachments={() => setPickFor(sel.key)}
              onConfirmMeeting={() => confirmMeeting(sel.key)}
              onGate={(action) => setGate({ action, key: sel.key, people: sel.kind === "row" ? sel.row.meta.people : sel.kind === "cold" ? sel.cold.people : [] })}
              onChanged={() => { loadPacks(); loadBoard(); }}
              onOpenDrafts={() => setDrawer("packs")}
              onSendDraft={sendDraft}
              onAttachDraft={(file, entryIndex, current) => setAttach({ file, entryIndex, current })}
            />
          )}
        </section>
      </div>

      {/* ── drawers & modals (kit overlays: Escape + outside-click, opaque) ── */}
      {drawer === "packs" && (
        <Drawer title="Draft packs — review → stage → send" onClose={() => setDrawer(null)}>
          <PacksList packs={packs} onStage={loadPacks} onSend={(p) => { setDrawer(null); setSendPack(p); }}
            onAttach={(file, entryIndex, current) => setAttach({ file, entryIndex, current })}
            onEdit={(file, entry, cur) => setEditDraft({ file, entry, subject: cur.subject, body: cur.body, to: cur.to, toEmail: cur.to })}
            onChanged={() => { loadPacks(); loadBoard(); }} />
        </Drawer>
      )}
      {drawer === "system" && view && (
        <Drawer title="System status — how the board was built" onClose={() => setDrawer(null)}>
          <SystemPanel view={view} sq={sq} engineErr={board?.engineErr ?? null}
            onUnfreeze={(key, email) => setGate({ action: "unfreeze", key, people: email ? [email] : [] })}
            onChanged={() => { loadPacks(); loadBoard({ force: true }); }} />
        </Drawer>
      )}
      {freshOpen && <FreshModal onClose={() => setFreshOpen(false)} onPicked={(emails) => {
        setFreshOpen(false);
        Promise.all(emails.map((e) => fetch("/api/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain: e.toLowerCase(), decision: "include", detail: "fresh pick" }) })))
          .then(() => { toast(`${emails.length} lead${emails.length !== 1 ? "s" : ""} added to today's pipeline`, { tone: "ok" }); loadBoard(); });
      }} />}
      {attach && <AttachPicker {...attach} onClose={() => setAttach(null)} onSaved={() => { setAttach(null); loadPacks(); toast("Attachment saved", { tone: "ok" }); }} />}
      {/* pre-draft picker: the selection waits with the company and rides its next draft run */}
      {pickFor && (
        <AttachPicker current={pendingAttach[pickFor] ?? []} onClose={() => setPickFor(null)}
          onPick={(paths) => {
            setPendingAttach((p) => {
              const n = { ...p };
              if (paths.length) n[pickFor] = paths; else delete n[pickFor];
              return n;
            });
            toast(paths.length
              ? `${paths.length} file${paths.length !== 1 ? "s" : ""} will attach when ${pickFor}'s reply is drafted`
              : `No files will attach for ${pickFor}`, { tone: "info" });
          }} />
      )}
      {/* the batch finished → pull today's corpus NOW (POST /api/board), then a
          forced reload re-runs the engine — the sent lead leaves "They're
          waiting on you" immediately, never on the 5-min timer (2026-07-12) */}
      {sendPack && <SendModal pack={sendPack} onClose={() => setSendPack(null)} onDone={async () => {
        loadPacks();
        await fetch("/api/board", { method: "POST" }).catch(() => {});
        loadBoard({ force: true });
      }} />}
      {/* cold group send: sample review + checks, then the SAME guarded send
          confirm as any other pack — no second send path exists. The modal is
          the shared group-send screen (Scraping's first emails use it too). */}
      {coldGroup && (
        <GroupSendModal source={{ kind: "cold-followups", group: coldGroup }} onClose={() => setColdGroup(null)}
          onStaged={(file) => { setColdGroup(null); sendDraft(file); }} />
      )}
      {/* an open (unsent) draft binds to the hold: the server writes the Meet
          link into the reply body and stamps the event on the entry */}
      {meetingFor && <MeetingForm row={meetingFor}
        draft={(() => { const t = board?.journeys[meetingFor.domain]; return t?.drafted && !t.packSent ? { file: t.drafted.pack } : null; })()}
        onClose={() => setMeetingFor(null)} onChanged={() => { loadPacks(); loadBoard({ force: true }); }} />}
      {editDraft && (
        <Modal title={`Edit draft · ${editDraft.to}`} wide dirty onClose={() => setEditDraft(null)}
          footer={<><Action onClick={() => setEditDraft(null)}>Cancel</Action><button onClick={saveEdit} className="rounded-ctl bg-accent px-4 py-1.5 text-body font-medium text-accent-contrast">Save (re-stage required)</button></>}>
          <div className="mb-3"><ToPicker current={editDraft.to} value={editDraft.toEmail} onChange={(email) => setEditDraft({ ...editDraft, toEmail: email })} /></div>
          <label className="block text-body text-ink-dim">Subject
            <input value={editDraft.subject} onChange={(e) => setEditDraft({ ...editDraft, subject: e.target.value })}
              className="mt-1 w-full rounded-card border border-line bg-well px-3 py-2 text-body text-ink outline-none focus:border-line-strong" />
          </label>
          <label className="mt-3 block text-body text-ink-dim">Body
            <textarea ref={editBodyRef} value={editDraft.body} onChange={(e) => setEditDraft({ ...editDraft, body: e.target.value })} rows={14}
              className="thin-scroll mt-1 w-full rounded-card border border-line bg-well px-3 py-2 text-body leading-relaxed text-ink outline-none focus:border-line-strong" />
          </label>
          <button
            onClick={() => {
              const at = editBodyRef.current?.selectionStart ?? editDraft.body.length;
              const r = insertTerms(editDraft.body, at, detectLang(editDraft.body));
              setEditDraft({ ...editDraft, body: r.body });
              requestAnimationFrame(() => { editBodyRef.current?.focus(); editBodyRef.current?.setSelectionRange(r.cursor, r.cursor); });
            }}
            className="mt-1.5 text-caption text-ink-dim underline-offset-2 hover:text-ink hover:underline">
            + Insert sales conditions (EXW)
          </button>
          <p className="mt-2 text-body text-ink-dim">Saving updates the pack and clears its staged marker — re-stage before sending. Keep the subject on established replies (it anchors the thread).</p>
        </Modal>
      )}
      {askInfoFor && (
        <ConfirmModal
          title={`Investigate with the agent · ${askInfoFor}`}
          body={<>The agent re-reads this company&apos;s whole thread and updates the notes and facts on file. It runs for a minute or so and spends tokens.{board?.decisions[askInfoFor] && board.decisions[askInfoFor].decision !== "clear" ? <> It also replaces the current &ldquo;{board.decisions[askInfoFor].decision === "skip" ? "set aside" : board.decisions[askInfoFor].decision}&rdquo; status on this company.</> : null}</>}
          confirmLabel="Run the agent"
          onConfirm={() => {
            const key = askInfoFor; setAskInfoFor(null);
            decide(key, "needs-info"); investigate(key);
          }}
          onClose={() => setAskInfoFor(null)}
        />
      )}
      {/* V4.2 directive dialogs — same verb on button, title and confirm */}
      {directive?.action === "hold" && (
        <HoldModal company={directive.key} today={today}
          onConfirm={(until, reason) => runDirective("hold", directive.key, { until, reason })}
          onClose={() => setDirective(null)} />
      )}
      {directive && directive.action !== "hold" && (
        <ConfirmModal
          title={`${directive.action === "unhold" ? "Bring back now" : directive.action === "personal" ? "Handling personally" : "Hand back to automation"} · ${directive.key}`}
          body={directive.action === "unhold" ? "Removes the hold — the company returns to its normal place on the list right away."
            : directive.action === "personal" ? <>Automation stops proposing touches for this company; their replies still surface, under &ldquo;In your hands&rdquo;. Undo any time with &ldquo;Hand back to automation&rdquo;.</>
            : "The deal returns to the normal follow-up rhythm — follow-ups can be suggested again."}
          reasonLabel={directive.action === "personal" ? "Why (recorded on the row)" : undefined}
          confirmLabel={directive.action === "unhold" ? "Bring back now" : directive.action === "personal" ? "Handling personally" : "Hand back to automation"}
          onConfirm={(reason) => runDirective(directive.action, directive.key, { reason })}
          onClose={() => setDirective(null)}
        />
      )}
      {/* the agent proposed a change — nothing is written until this confirm */}
      {proposal && (
        <ConfirmModal
          title={`The agent suggests · ${proposal.key}`}
          body={<>
            {proposal.action === "hold"
              ? <>Put {proposal.key} on hold until <span className="font-medium text-ink">{holdDay(proposal.until ?? "")}</span> — it comes back on that date by itself, sooner if they reply.</>
              : <>Move {proposal.key} into your hands — automation stops proposing touches; their replies still surface.</>}
            {proposal.reason && <p className="mt-2 text-caption">Its reasoning: {proposal.reason}</p>}
            <p className="mt-2 text-caption">Nothing is saved unless you confirm.</p>
          </>}
          confirmLabel={proposal.action === "hold" ? `Hold until ${holdDay(proposal.until ?? "")}` : "Handling personally"}
          onConfirm={() => runDirective(proposal.action, proposal.key, { until: proposal.until, reason: proposal.reason ?? "agent suggestion, operator-confirmed" })}
          onClose={() => setProposal(null)}
        />
      )}
      {/* the agent answered a question — read-only, nothing was written */}
      {agentAnswer && (
        <Modal title={`The agent's read · ${agentAnswer.key}`} onClose={() => setAgentAnswer(null)}
          footer={<Action onClick={() => setAgentAnswer(null)}>Close</Action>}>
          <p className="whitespace-pre-wrap text-body leading-relaxed text-ink">{agentAnswer.text}</p>
          <p className="mt-3 text-caption text-ink-dim">Answer only — no draft was written and nothing changed.</p>
        </Modal>
      )}
      {cancelMeetingFor && (
        <ConfirmModal
          title={`Cancel the meeting · ${cancelMeetingFor.key}`}
          danger
          body={cancelMeetingFor.inviteSent
            ? "This removes the meeting from the calendar and Google notifies the guests it was cancelled."
            : "This removes the held time from the calendar. Nobody was ever notified of it, so nobody is notified now."}
          confirmLabel="Cancel the meeting"
          onConfirm={() => runCancelMeeting(cancelMeetingFor)}
          onClose={() => setCancelMeetingFor(null)}
        />
      )}
      {/* the ONE gate dialog — same words as Pipeline's, by construction */}
      {gate && (
        <GateConfirm action={gate.action} name={gate.key}
          onConfirm={(reason) => runGate(gate, reason)}
          onClose={() => setGate(null)} />
      )}
      <Toaster />
    </div>
  );
}

function ErrorRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-card border border-tone-bad/40 bg-tone-bad/[0.06] px-3 py-2 text-body text-tone-bad-ink">
      Couldn&apos;t load the board.{" "}
      <button onClick={onRetry} className="font-medium underline underline-offset-2">Retry</button>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label="Loading the board">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="rounded-card bg-fill-1 px-4 py-3.5"
          style={{ animation: "breathe 2.2s var(--ease-soft) infinite", animationDelay: `${i * 120}ms` }}>
          <div className="h-3 w-1/3 rounded bg-fill-3" />
          <div className="mt-2 h-2.5 w-3/4 rounded bg-fill-2" />
        </div>
      ))}
    </div>
  );
}
