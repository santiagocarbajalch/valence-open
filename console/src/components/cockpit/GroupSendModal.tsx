"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Action, Modal, Skeleton, toast } from "@/components/kit";
import { pollJob } from "@/lib/pollJob";
import type { ColdGroup } from "./types";

// THE group-send screen (ONE DESK port, 2026-07-12). Templated outreach is
// one email with merge fields, so a group sends off ONE reviewed sample —
// this flow existed twice, near line-for-line (ColdBatchModal for Today's
// cold follow-ups, ColdOpenModal for Scraping's first emails). Now it exists
// once, fed by a source:
//
//   cold-followups — a language × ladder-step group from today's cold plan
//                    (writes via /api/cold-batch; carries the group rewrite
//                    strip — one instruction honestly revises all N)
//   first-emails   — a landed scraping batch (plans + writes via
//                    /api/scraping/outreach; opens with the plan screen:
//                    who is fresh, who is left out and why)
//
// Both roads end the same way: the full check chain (/api/stage), then the
// normal guarded send screen. This modal never sends anything itself; the
// send gate stays exactly where it always was (tenet 24).

export type GroupSendSource =
  | { kind: "cold-followups"; group: ColdGroup }
  | { kind: "first-emails"; batchFile: string; batchLabel: string };

interface Revision { ts?: string; summary?: string; instruction?: string }
interface DraftEntry { institution?: string; to_email?: string; to_name?: string; subject?: string; body?: string; _revisions?: Revision[] }
interface PlanCompany { institution: string; email: string; country: string }
interface PlanGroup { lang: string; count: number; companies: PlanCompany[] }
interface Plan { openable: number; groups: PlanGroup[]; skipped: Record<string, number>; error?: string }
// "peeking"/"empty" = the lazy-generation gate (audit fix 2026-07-17): opening
// the modal must NOT auto-fire the writing agent. A cold group peeks the drafts
// dir read-only; if a pack is already on disk it shows the sample, otherwise it
// waits on an explicit "Write the N drafts…" click.
type Phase = "plan" | "peeking" | "empty" | "writing" | "sample" | "checking";

const LANG_WORD: Record<string, string> = { spanish: "Spanish", english: "English" };
const SKIP_WORD: Record<string, string> = {
  already_contacted: "already emailed before",
  dnc: "on the do-not-contact list",
  no_email: "no email address",
  banned_geo: "blocked country",
  duplicate_company: "same company, second address",
};

export function GroupSendModal({ source, onClose, onStaged }: {
  source: GroupSendSource;
  onClose: () => void;
  onStaged: (file: string) => void; // parent opens the guarded send confirm
}) {
  const cold = source.kind === "cold-followups";
  // "group" for a cold-plan group, "batch" for a scraping batch — the copy
  // below names the unit the operator actually clicked
  const unit = cold ? "group" : "batch";

  const [phase, setPhase] = useState<Phase>(cold ? "peeking" : "plan");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [count, setCount] = useState(cold ? source.group.count : 0);
  const [entries, setEntries] = useState<DraftEntry[]>([]);
  const [kept, setKept] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastLang, setLastLang] = useState<string | null>(null);
  // group rewrite (cold follow-ups only — the revise-group agent path is
  // guarded to cold-followup packs server-side)
  const [instruction, setInstruction] = useState("");
  const [revBusy, setRevBusy] = useState(false);
  const [revDone, setRevDone] = useState(false);
  const [revErr, setRevErr] = useState<string | null>(null);
  const cancelPoll = useRef<(() => void) | null>(null);
  const dead = useRef(false);
  useEffect(() => () => { dead.current = true; cancelPoll.current?.(); }, []);

  // first-emails: the plan screen comes first — who is fresh, who is left out
  useEffect(() => {
    if (source.kind !== "first-emails") return;
    fetch(`/api/scraping/outreach?batch=${encodeURIComponent(source.batchFile)}`)
      .then((r) => r.json())
      .then((d: Plan) => { if (!dead.current) { if (d.error) setErr(d.error); else setPlan(d); } })
      .catch(() => { if (!dead.current) setErr("Couldn't read the batch."); });
    // the source object is stable for the modal's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadEntries = useCallback(async (f: string) => {
    const p = await fetch(`/api/drafts?file=${encodeURIComponent(f)}`).then((x) => x.json());
    if (dead.current) return;
    const list = (Object.values(p.pack ?? {}).filter(Array.isArray) as DraftEntry[][]).flat();
    setEntries(list);
    if (list.length > 0) setCount(list.length);
  }, []);

  // write the drafts (or keep a version the operator already changed today),
  // then load the sample
  const generate = useCallback(async (opts?: { lang?: string; fresh?: boolean }) => {
    setPhase("writing"); setErr(null); setRevDone(false); setRevErr(null);
    if (opts?.lang) setLastLang(opts.lang);
    try {
      const r = cold
        ? await fetch("/api/cold-batch", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lang: source.group.lang, step: source.group.step, ...(opts?.fresh ? { fresh: true } : {}) }),
          })
        : await fetch("/api/scraping/outreach", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ batch: source.batchFile, lang: opts?.lang, ...(opts?.fresh ? { fresh: true } : {}) }),
          });
      const d = await r.json();
      if (dead.current) return;
      if (!r.ok) { setErr(d.error ?? "Couldn't write the drafts."); setPhase(cold ? "empty" : "plan"); return; }
      setFile(d.file); setCount(d.count); setKept(Boolean(d.revisedKept));
      await loadEntries(d.file);
      if (!dead.current) setPhase("sample");
    } catch { if (!dead.current) { setErr("Couldn't write the drafts."); setPhase(cold ? "empty" : "plan"); } }
    // cold group identity is fixed for the modal's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cold, loadEntries]);

  // cold follow-ups: NO auto-generation (tenet 25; audit 2026-07-17). Peek the
  // drafts dir read-only — if today's pack for this group is already written,
  // show its sample straight away; otherwise wait on an explicit click.
  useEffect(() => {
    if (source.kind !== "cold-followups") return;
    const today = new Date().toLocaleDateString("en-CA");
    const f = `${today}__cold-followups__${source.group.lang}__${source.group.step}.json`;
    fetch(`/api/drafts?file=${encodeURIComponent(f)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (dead.current) return;
        const list = p ? (Object.values(p.pack ?? {}).filter(Array.isArray) as DraftEntry[][]).flat() : [];
        if (list.length > 0) { setFile(p.file ?? f); setEntries(list); setCount(list.length); setPhase("sample"); }
        else setPhase("empty");
      })
      .catch(() => { if (!dead.current) setPhase("empty"); });
    // the cold group is fixed for the modal's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runChecks = async () => {
    if (!file || revBusy) return;
    setPhase("checking"); setErr(null);
    const r = await fetch("/api/stage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    });
    const d = await r.json();
    if (!d.jobId) { setErr(d.error ?? "The checks couldn't start."); setPhase("sample"); return; }
    cancelPoll.current = pollJob(d.jobId, (ok, out) => {
      if (ok) { onStaged(file); return; }
      // the failure banner renders at the TOP of this modal (2026-07-13
      // incident: a bottom-of-modal error was invisible and the operator
      // believed the send was in flight), and a toast fires in case the
      // modal is already closed — the task tray keeps the durable record.
      setErr(`Blocked — nothing was staged or sent for this ${unit}. A failed check stops all ${count} together. The check said:\n` + out.slice(-600));
      toast(`Checks blocked the ${unit} — nothing was staged or sent.`, { tone: "bad" });
      setPhase("sample");
    });
  };

  const rewriteGroup = async () => {
    const text = instruction.trim();
    if (!file || !text || revBusy) return;
    setRevBusy(true); setRevErr(null); setRevDone(false);
    const done = (ok: boolean, msg?: string) => {
      if (dead.current) return;
      setRevBusy(false);
      if (ok) { setInstruction(""); setRevDone(true); }
      else setRevErr(msg ?? "The rewrite failed — every draft is unchanged.");
    };
    const r = await fetch("/api/workbench", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revise-group", file, instruction: text }),
    });
    const d = await r.json();
    if (!d.jobId) { done(false, `Couldn't start the rewrite: ${d.error ?? "error"}`); return; }
    cancelPoll.current = pollJob(d.jobId, async (ok) => {
      if (ok) await loadEntries(file);
      done(ok);
    });
  };

  const sample = entries[0] ?? null;
  const revisions = sample?._revisions ?? [];
  const skips = Object.entries(plan?.skipped ?? {}).filter(([, n]) => n > 0);
  // first emails are where geography is decided (operator ruling 2026-07-13:
  // geo is bounded when a batch is composed, never at the send checks) — so
  // the plan screen names the batch's client type and geography outright
  const batchParts = cold ? [] : source.batchLabel.split("__");
  const batchScope = batchParts.length >= 3
    ? `Client type: ${batchParts[1].replace(/-/g, " ")} · Geography: ${batchParts.slice(2).join(", ").replace(/-/g, " ")}`
    : null;
  const title = cold
    ? `Send to the whole group · ${source.group.label}`
    : `First email to the fresh leads · ${source.batchLabel}`;

  return (
    <Modal title={title} wide onClose={onClose}
      footer={<>
        <Action onClick={onClose}>Cancel</Action>
        {phase === "sample" && sample && (
          <Action variant="primary" onClick={runChecks} disabled={revBusy}>Looks right — check all {count}</Action>
        )}
      </>}>

      {err && (
        <div role="alert" className="mb-3 rounded-card border border-tone-bad/45 border-l-[3px] border-l-tone-bad bg-tone-bad/[0.06] px-3 py-2">
          <p className="whitespace-pre-wrap text-caption text-tone-bad-ink">{err}</p>
        </div>
      )}

      {phase === "plan" && !plan && !err && (
        <div role="status" aria-label="Reading the batch">
          <p className="text-body text-ink-dim">Checking who in this batch is still fresh…</p>
          <div className="mt-3"><Skeleton rows={3} /></div>
        </div>
      )}

      {phase === "plan" && plan && (
        <>
          {plan.openable === 0 ? (
            <p className="text-body text-ink">
              Nobody in this batch can get a first email — everyone was already emailed, is blocked, or has no address.
            </p>
          ) : (
            <>
              <p className="text-body text-ink">
                <span className="font-medium">{plan.openable} compan{plan.openable === 1 ? "y is" : "ies are"} fresh</span> — never emailed,
                not on the do-not-contact list. Every company in a language group gets the same first email; only the
                company name, the greeting and the subject line change.
              </p>
              {batchScope && <p className="mt-1 text-caption text-ink-dim">{batchScope}</p>}
              <div className="mt-2.5 flex flex-col gap-1.5">
                {plan.groups.map((g) => (
                  <div key={g.lang} className="flex items-center gap-2 rounded-card border border-line bg-well px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-body text-ink">
                      {LANG_WORD[g.lang] ?? g.lang} · {g.count} compan{g.count === 1 ? "y" : "ies"}
                      <span className="ml-2 text-caption text-ink-dim">{g.companies.slice(0, 3).map((c) => c.institution).join(", ")}{g.count > 3 ? "…" : ""}</span>
                    </span>
                    <Action variant="primary" onClick={() => generate({ lang: g.lang })}>Write the {g.count} email{g.count !== 1 ? "s" : ""}</Action>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-caption text-ink-dim">
                Writing the drafts sends nothing — you review the exact email next, and the final send screen still asks you to confirm.
              </p>
            </>
          )}
          {skips.length > 0 && (
            <details className="mt-2.5">
              <summary className="cursor-pointer text-caption text-tone-info-ink underline underline-offset-2">
                Left out ({skips.reduce((a, [, n]) => a + n, 0)})
              </summary>
              <ul className="mt-1">
                {skips.map(([k, n]) => (
                  <li key={k} className="text-caption text-ink-dim">{n} — {SKIP_WORD[k] ?? k}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {phase === "peeking" && !err && (
        <div role="status" aria-label="Checking for drafts">
          <p className="text-body text-ink-dim">Looking for drafts already written for this group…</p>
          <div className="mt-3"><Skeleton rows={2} /></div>
        </div>
      )}

      {/* the lazy-generation gate: no drafts on disk yet, so nothing has run —
          the operator writes them with an explicit, cost-stated click */}
      {phase === "empty" && (
        <>
          <p className="text-body text-ink">
            <span className="font-medium">{count} compan{count === 1 ? "y gets" : "ies get"} this exact email</span>{" "}
            — the company name, the greeting and the subject line are merged per recipient.
          </p>
          <div className="mt-2.5 rounded-card border border-line bg-well px-3 py-3">
            <p className="text-body text-ink-dim">No drafts written yet.</p>
            <p className="mt-1 text-caption text-ink-dim">
              Writing runs the writing agent (about a minute) and sends nothing — you review the exact email next, and the final send screen still asks you to confirm.
            </p>
            <div className="mt-2.5">
              <Action variant="primary" onClick={() => generate()}>Write the {count} draft{count === 1 ? "" : "s"}…</Action>
            </div>
          </div>
        </>
      )}

      {phase === "writing" && (
        <div role="status" aria-label="Writing the drafts">
          <p className="text-body text-ink-dim">{cold ? "Writing today's follow-ups for this group…" : "Writing the first emails for this batch…"}</p>
          <div className="mt-3"><Skeleton rows={3} /></div>
        </div>
      )}

      {phase === "sample" && sample && (
        <>
          <p className="text-body text-ink">
            <span className="font-medium">{count} compan{count === 1 ? "y gets" : "ies get"} this exact email.</span>{" "}
            Only the company name, the greeting and the subject line change from one recipient to the next.
          </p>

          {kept && (
            <p className="mt-1.5 text-caption text-tone-info-ink">
              You {cold ? "rewrote this group's email" : "edited these drafts"} earlier today — that version is kept below.{" "}
              <button type="button"
                onClick={() => generate({ fresh: true, ...(cold ? {} : { lang: lastLang ?? (file?.includes("__spanish__") ? "spanish" : "english") }) })}
                className="cursor-pointer underline underline-offset-2">
                Start over with the standard wording
              </button>
            </p>
          )}

          {revBusy && (
            <p className="mt-1.5 text-caption text-accent" role="status">
              <span aria-hidden>✦ </span>The agent is rewriting the group&apos;s email — the new text replaces the one below for all {count} when it finishes (about a minute).
            </p>
          )}
          {revDone && !revBusy && (
            <p className="mt-1.5 text-caption text-tone-ok-ink" role="status">
              ✓ Rewritten for all {count} — the updated email is below, and the change is logged.
            </p>
          )}

          <div className={`mt-2.5 rounded-card border border-line bg-well px-3 py-2.5${revBusy ? " opacity-50" : ""}`}>
            <p className="text-caption text-ink-dim">To (this one, as the example): <span className="text-ink">{sample.to_email}</span></p>
            <p className="mt-1 text-caption text-ink-dim">Subject: <span className="font-medium text-ink">{sample.subject}</span></p>
            <pre className="thin-scroll mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap font-sans text-body leading-relaxed text-ink">{sample.body}</pre>
          </div>

          {cold && (
            <div className="mt-2.5 rounded-ctl border border-line bg-fill-1 px-3 py-2.5">
              <div className="mb-1.5 text-caption font-medium text-ink-dim">Rewrite this email — the change applies to the whole group</div>
              {revisions.length > 0 && (
                <ul className="mb-2">
                  {revisions.slice(-3).map((r, i) => (
                    <li key={i} className="text-caption text-ink-dim">✓ {r.summary || r.instruction || "rewritten"}</li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2">
                <input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") rewriteGroup(); }}
                  disabled={revBusy}
                  placeholder="What should change? e.g. “shorter, and lead with the catalog”"
                  aria-label="Rewrite instruction for the whole group"
                  className="min-w-0 flex-1 rounded-ctl border border-line bg-well px-3 py-1.5 text-caption text-ink placeholder:text-ink-faint outline-none focus:border-line-strong"
                />
                <Action variant={instruction.trim() ? "primary" : "neutral"} onClick={rewriteGroup} disabled={revBusy || !instruction.trim()}>
                  {revBusy ? "Rewriting…" : `Rewrite all ${count}`}
                </Action>
              </div>
              {revErr && !revBusy && <p className="mt-1.5 text-caption text-tone-bad-ink" role="alert">{revErr}</p>}
            </div>
          )}

          <details className="mt-2">
            <summary className="cursor-pointer text-caption text-tone-info-ink underline underline-offset-2">
              {cold ? `Everyone in this group (${count})` : `Everyone getting it (${count})`}
            </summary>
            <ul className="thin-scroll mt-1 max-h-40 overflow-y-auto">
              {entries.map((e, i) => (
                <li key={i} className="flex items-baseline gap-2 border-b border-line py-1 last:border-0">
                  <span className="min-w-0 flex-1 truncate text-caption text-ink">{e.institution || e.to_email}</span>
                  <span className="shrink-0 text-caption text-ink-dim">{e.to_email}</span>
                </li>
              ))}
            </ul>
          </details>

          <p className="mt-2.5 text-caption text-ink-dim">
            Next, every draft goes through the usual safety checks — right conversation, right timing,
            do-not-contact, no duplicates — and lines up in Gmail. Nothing is sent yet: the final
            send screen still asks you to confirm, and a failed check stops the whole {unit}.
          </p>
        </>
      )}

      {phase === "checking" && (
        <div role="status" aria-label="Running the safety checks">
          <p className="text-body text-ink"><span aria-hidden>✦ </span>Checking and lining up {count} drafts in Gmail…</p>
          <p className="mt-1 text-caption text-ink-dim">A big {unit} takes a couple of minutes. The send confirm opens by itself when the checks pass.</p>
        </div>
      )}

    </Modal>
  );
}
