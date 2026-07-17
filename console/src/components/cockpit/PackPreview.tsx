"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Action, Chip, Clamp, StatusChip, TypeTag, cx, toast } from "@/components/kit";
import { pollJob } from "@/lib/pollJob";
import { companyKey } from "@/lib/companyKey";
import { detectLang, insertTerms } from "@/lib/salesTerms";
import { humanType } from "./labels";
import { day } from "./types";

// The draft workbench surface — each pack entry shows the ACTUAL email (subject,
// body, recipient, attachments) AND carries its own revision conversation.
// A11y rebuild 2026-07-03: sentence case (the small-caps runs read slower and
// were low-contrast), and DraftCard now has exactly ONE stage affordance — the
// audit found three near-identical "stage" controls stacked in 120px.

interface Revision { ts?: string; by?: string; instruction?: string; summary?: string }
interface Entry {
  to_email?: string; to_name?: string; institution?: string; draft_type?: string;
  subject?: string; body?: string; lang?: string; attachments?: string[]; _thread?: string;
  _revisions?: Revision[];
  // set by the packaged confirm-meeting run: a held Meet call bound to this draft
  _meet_url?: string; _meet_event_id?: string;
}

export function usePack(file: string | null) {
  const [pack, setPack] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(() => {
    if (!file) return;
    setLoading(true);
    // no-store: a just-revised pack must never come back from the browser cache
    fetch(`/api/drafts?file=${encodeURIComponent(file)}`, { cache: "no-store" }).then((r) => r.json()).then((d) => setPack(d.pack ?? null)).catch(() => {}).finally(() => setLoading(false));
  }, [file]);
  useEffect(reload, [reload]);
  return { pack, loading, reload };
}

export function entriesOf(pack: Record<string, unknown> | null): Entry[] {
  if (!pack) return [];
  const out: Entry[] = [];
  for (const v of Object.values(pack)) if (Array.isArray(v)) out.push(...(v as Entry[]));
  return out;
}

const fname = (p: string) => p.split("/").pop() ?? p;
const clock = (ts?: string) => (ts ? new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "");

// The draft body, with the lines a revision changed HIGHLIGHTED in place.
// `base` = the body as it was when the revision started; null = plain render.
// A zero-line diff is called out explicitly — "the agent made no text change"
// is a result the operator must see, not infer (e.g. a refused instruction).
function DiffBody({ body, base, dim, inkClass, summary, onDismiss }: {
  body: string; base: string | null; dim?: boolean; inkClass: string;
  summary?: string | null; onDismiss: () => void;
}) {
  if (base == null || base === undefined) {
    return <div className={cx("whitespace-pre-wrap text-caption leading-relaxed", inkClass, dim && "opacity-30")}>{body || "— empty —"}</div>;
  }
  const oldLines = new Set(base.split("\n"));
  const lines = body.split("\n");
  const changed = lines.filter((l) => l.trim() && !oldLines.has(l)).length;
  return (
    <>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 text-caption">
        {changed > 0 ? (
          <span className="font-medium text-accent"><span aria-hidden>✦ </span>{changed} changed line{changed !== 1 ? "s" : ""} — highlighted below</span>
        ) : (
          <span className="font-medium text-tone-warn-ink">The agent made NO text change — read its note below.</span>
        )}
        <button onClick={onDismiss} className="text-ink-dim underline underline-offset-2 hover:text-ink">clear highlight</button>
      </div>
      <div className={cx("whitespace-pre-wrap text-caption leading-relaxed", inkClass, dim && "opacity-30")}>
        {lines.map((l, i) => (
          <span key={i} className={l.trim() && !oldLines.has(l) ? "rounded-sm bg-accent/15 font-medium text-ink shadow-[inset_2px_0_0_var(--accent)]" : undefined}>
            {l + "\n"}
          </span>
        ))}
      </div>
      {summary && <p className="mt-1.5 border-t border-line pt-1.5 text-caption italic text-ink-dim">Agent&apos;s note: {summary}</p>}
    </>
  );
}

// Recipient picker — SAME COMPANY only (V4.1 Phase 6). Options come from the
// company's thread participants; the server enforces the same-company rule too.
export function ToPicker({ current, value, onChange }: {
  current: string; value: string; onChange: (email: string) => void;
}) {
  const [contacts, setContacts] = useState<string[]>([]);
  useEffect(() => {
    const key = companyKey(current);
    if (!key) return;
    fetch(`/api/thread?key=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => setContacts(((t?.people ?? []) as string[]).filter((p) => p.includes("@"))))
      .catch(() => {});
  }, [current]);
  const opts = [...new Set([current, ...contacts])].filter(Boolean);
  return (
    <div>
      <label className="block text-caption text-ink-dim">To (same company only)
        <select value={value} onChange={(ev) => onChange(ev.target.value)} aria-label="Recipient"
          className="mt-1 w-full rounded-ctl border border-line bg-well px-3 py-1.5 text-caption text-ink outline-none focus:border-line-strong">
          {opts.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      {value !== current && (
        <p className="mt-1 text-caption text-tone-warn-ink">
          New contact — the reply thread is rebuilt for them and the draft must be re-staged before sending.
        </p>
      )}
    </div>
  );
}

function RevisionLog({ revisions }: { revisions: Revision[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {revisions.map((r, i) => (
        <div key={i} className="text-caption text-ink-dim">
          <span className="text-ink-faint">{day(r.ts)} {clock(r.ts)} · You: </span>
          <span className="text-ink">“{r.instruction || "—"}”</span>
          {r.summary && <span className="text-ink-faint"> → {r.summary}</span>}
        </div>
      ))}
    </div>
  );
}

// One entry's revision conversation — lives ON the draft, updates it in place.
// ALL feedback is inline (doctrine: feedback lives where the work is): the busy
// state renders on the draft body itself via onBusyChange, the result is the
// updated text above plus an inline confirmation — never a corner toast.
// Staging is a different step and is never touched from here.
function RevisionStrip({ file, entry, revisions, onApplied, onBusyChange }: {
  file: string; entry: number; revisions: Revision[]; onApplied: () => void;
  onBusyChange?: (busy: boolean, instruction?: string) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const revise = async () => {
    const text = instruction.trim();
    if (!text || busy) return;
    setBusy(true); setError(null); setApplied(false);
    onBusyChange?.(true, text);
    const done = (ok: boolean, err?: string) => {
      setBusy(false); onBusyChange?.(false);
      if (ok) { setInstruction(""); setApplied(true); onApplied(); }
      else setError(err ?? "The revision failed — the draft is unchanged.");
    };
    const res = await fetch("/api/workbench", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revise", file, entry, instruction: text }),
    });
    const d = await res.json();
    if (!d.jobId) { done(false, `Couldn't start the revision: ${d.error ?? "error"}`); return; }
    pollJob(d.jobId, (ok) => done(ok));
  };

  return (
    <div className="mt-2.5 rounded-ctl border border-line bg-fill-1 px-3 py-2.5">
      {/* named for its one job — pairs with the deal-level "Ask the assistant"
          box below without reading as a duplicate (audit 2026-07-10) */}
      <div className="mb-1.5 text-caption font-medium text-ink-dim">Rewrite this draft</div>
      {revisions.length > 0 && <div className="mb-2"><RevisionLog revisions={revisions} /></div>}
      <div className="flex items-center gap-2">
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") revise(); }}
          disabled={busy}
          placeholder="What should change in this email? e.g. “shorter, and mention the catalog”"
          aria-label="Rewrite instruction for this draft"
          className="min-w-0 flex-1 rounded-ctl border border-line bg-well px-3 py-1.5 text-caption text-ink placeholder:text-ink-faint outline-none focus:border-line-strong"
        />
        {/* v4 §3.4: secondary until there's an instruction — a primary-styled
            button in a permanent disabled state reads as "broken", not "waiting" */}
        <Action variant={instruction.trim() ? "primary" : "neutral"} onClick={revise} disabled={busy || !instruction.trim()}>
          {busy ? "Rewriting…" : "Rewrite"}
        </Action>
      </div>
      {busy && (
        <p className="mt-1.5 text-caption text-accent" role="status">
          <span aria-hidden>✦ </span>The agent is rewriting the draft above — the new text appears in place when it finishes (about a minute).
        </p>
      )}
      {applied && !busy && (
        <p className="mt-1.5 text-caption text-tone-ok-ink" role="status">
          ✓ Revised — the updated text is above, and the change is logged. Staging is a separate step, whenever you&apos;re ready.
        </p>
      )}
      {error && !busy && <p className="mt-1.5 text-caption text-tone-bad-ink" role="alert">{error}</p>}
    </div>
  );
}

// ── the IN-ROW draft card — V5 (operator 2026-07-10) ────────────────────────
// Gmail-shaped: To / Subject / Body editable in place, Attach from the vault,
// and SEND. Staging is an internal step the Send flow runs for you; no staging
// language on the card. Rewrites go through the one Valence box below.
export function DraftCard({ file, entry, staged, stagedAt, stale, onChanged, onOpenDrafts, onSend, onAttach, moreMenu }: {
  file: string;             // base pack file name
  entry: number;            // flat entry index in the pack
  staged: boolean;          // pack has a live .staged marker
  stagedAt?: string | null; // when, if known
  stale?: boolean;          // draft predates their latest message — Send yields the weight to "Draft a fresh reply"
  onChanged: () => void;    // packs/board should refresh
  onOpenDrafts?: () => void;
  onSend?: (file: string) => void;                       // open the guarded send confirm
  onAttach?: (entryIndex: number, current: string[]) => void; // vault asset picker
  moreMenu?: React.ReactNode; // the ONE "More ▾" menu — rendered in the action bar beside Send
}) {
  const { pack, loading, reload } = usePack(file);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [toEmail, setToEmail] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [staging, setStaging] = useState(false);
  // in-place revision feedback: the body itself shows the agent working, then
  // the changed lines render HIGHLIGHTED against the pre-revision snapshot
  // (no toasts — feedback lives on the draft)
  const [revising, setRevising] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [diffBase, setDiffBase] = useState<string | null>(null);
  const e = entriesOf(pack)[entry];

  const startEdit = () => { if (!e) return; setSubject(e.subject ?? ""); setBody(e.body ?? ""); setToEmail(e.to_email ?? ""); setDiffBase(null); setEditing(true); };
  const saveEdit = async () => {
    const changedTo = toEmail && toEmail !== e?.to_email;
    const res = await fetch("/api/drafts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      // a new contact keeps no stale display name — the server stores what we send
      body: JSON.stringify({ file, entry, subject, body, original_to: e?.to_email, ...(changedTo ? { to_email: toEmail, to_name: "" } : {}) }),
    });
    if (res.ok) {
      setEditing(false);
      toast(changedTo ? `Draft re-addressed to ${toEmail} — re-stage before sending` : "Draft saved — re-stage before sending", { tone: "ok" });
      reload(); onChanged();
    }
    else toast(`Save failed: ${(await res.json()).error ?? "error"}`, { tone: "bad" });
  };
  // V5 Send: staging is an internal step. Not staged → run the gate chain
  // (auto-splits multi-company bundles server-side), then hand off to the
  // guarded send confirm. Already staged → straight to the confirm.
  const sendNow = async () => {
    if (staged) { onSend?.(file); return; }
    setStaging(true);
    const res = await fetch("/api/stage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file }) });
    const d = await res.json();
    if (!d.jobId) { toast(`Couldn't prepare the send: ${d.error ?? "error"}`, { tone: "bad" }); setStaging(false); return; }
    pollJob(d.jobId, (ok) => {
      setStaging(false);
      reload(); onChanged();
      if (!ok) { toast("A safety gate stopped this send — check the draft.", { tone: "warn" }); return; }
      if (d.split) { toast("This bundle was reorganized into per-company drafts — press Send again.", { tone: "info" }); return; }
      onSend?.(file);
    }, 3000);
  };

  // the lead actions must survive a missing/slow pack — the bar is part of the
  // console, not of the draft (the draft is just its head content)
  if ((loading && !pack) || !e) {
    return (
      <div>
        <div className="px-3 py-3 text-center text-caption text-ink-dim">
          {loading && !pack ? "Loading draft…" : "This draft isn't readable right now — refresh, or draft again."}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
          <span className="min-w-2 flex-1" aria-hidden />
          {moreMenu}
          <Action variant="primary" onClick={() => {}} disabled>Send…</Action>
        </div>
      </div>
    );
  }
  const revisions = e._revisions ?? [];

  // V5.1: no card chrome of its own — the unified lead console (ThreadPane)
  // owns the one outer border; this is its head content.
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium text-accent"><span aria-hidden>✦ </span>Draft — yours to edit; nothing sends without your confirmation</span>
        <span className="ml-auto text-caption text-ink-dim">To <span className="readout text-ink">{e.to_name || e.to_email}</span>{e.to_name ? <span className="readout text-ink-dim"> · {e.to_email}</span> : null}</span>
      </div>

      {editing ? (
        <>
          <div className="mb-1.5"><ToPicker current={e.to_email ?? ""} value={toEmail} onChange={setToEmail} /></div>
          <input value={subject} onChange={(ev) => setSubject(ev.target.value)} aria-label="Subject"
            className="mb-1.5 w-full rounded-ctl border border-line bg-well px-3 py-1.5 text-caption text-ink outline-none focus:border-line-strong" />
          <textarea ref={bodyRef} value={body} onChange={(ev) => setBody(ev.target.value)} rows={10} aria-label="Body"
            className="thin-scroll w-full rounded-ctl border border-line bg-well px-3 py-2 text-caption leading-relaxed text-ink outline-none focus:border-line-strong" />
          <div className="mt-1.5 flex items-center gap-1.5">
            {/* THE house sales-conditions sentence (one canonical form, lib/salesTerms) —
                dropped in at the cursor as its own paragraph */}
            <button
              onClick={() => {
                const at = bodyRef.current?.selectionStart ?? body.length;
                const r = insertTerms(body, at, e.lang ?? detectLang(body));
                setBody(r.body);
                requestAnimationFrame(() => { bodyRef.current?.focus(); bodyRef.current?.setSelectionRange(r.cursor, r.cursor); });
              }}
              className="text-caption text-ink-dim underline-offset-2 hover:text-ink hover:underline">
              + Insert sales conditions (EXW)
            </button>
            <span className="min-w-2 flex-1" aria-hidden />
            <Action onClick={() => setEditing(false)}>Cancel</Action>
            <Action variant="primary" onClick={saveEdit}>Save</Action>
          </div>
        </>
      ) : (
        <>
          <div className="text-caption text-ink"><span className="text-ink-dim">Subject: </span>{e.subject || <span className="text-tone-bad-ink">— missing —</span>}</div>
          <div className={cx("relative mt-1.5 rounded-ctl bg-well px-3 py-2 transition-shadow duration-500",
            flash && "shadow-[0_0_0_2px_var(--accent)]")}>
            <DiffBody body={e.body ?? ""} base={revising ? null : diffBase} dim={!!revising} inkClass="text-ink"
              summary={revising ? null : (e._revisions ?? [])[(e._revisions ?? []).length - 1]?.summary}
              onDismiss={() => setDiffBase(null)} />
            {revising && (
              <div className="absolute inset-0 grid place-items-center rounded-ctl" role="status" aria-label="Revising the draft">
                <div className="max-w-[85%] rounded-card border border-accent/40 bg-fill-1 px-3 py-2 text-center"
                  style={{ animation: "breathe 1.8s var(--ease-soft) infinite" }}>
                  <div className="text-caption font-medium text-accent"><span aria-hidden>✦ </span>Revising this draft…</div>
                  <div className="mt-0.5 truncate text-caption text-ink-dim">“{revising}”</div>
                </div>
              </div>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            {/* V5.1: the two draft verbs level as the same quiet link (audit
                item 6 — Attach was louder than Edit and competed with links) */}
            <button onClick={startEdit} disabled={!!revising}
              className="text-caption text-ink-dim underline-offset-2 hover:text-ink hover:underline disabled:opacity-40">
              ✎ Edit
            </button>
            {onAttach && (
              <button onClick={() => onAttach(entry, e.attachments ?? [])} disabled={!!revising}
                className="text-caption text-ink-dim underline-offset-2 hover:text-ink hover:underline disabled:opacity-40">
                {(e.attachments?.length ?? 0) > 0 ? "Change attachments" : "Attach files…"}
              </button>
            )}
            {revisions.length > 0 && (
              <button onClick={() => setShowHistory((v) => !v)} className="text-caption text-ink-dim hover:text-ink" aria-expanded={showHistory}>
                {showHistory ? "▾" : "▸"} {revisions.length} revision{revisions.length !== 1 ? "s" : ""}
              </button>
            )}
          </div>
          {showHistory && revisions.length > 0 && (
            <div className="mt-1.5 rounded-ctl bg-well px-3 py-2"><RevisionLog revisions={revisions} /></div>
          )}
        </>
      )}

      {/* MEET HELD — a confirm-meeting run bound a held Google Meet call to this
          draft; the link rides the body and fires only at the approved send */}
      {!editing && e._meet_url && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Chip hue="meet">MEET HELD ✓</Chip>
          <span className="text-caption text-ink-dim">Held on the calendar — nobody notified yet; the invite goes out when you send.</span>
        </div>
      )}

      {/* attachment chips — the verbs live with Edit above */}
      {!editing && (e.attachments?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {(e.attachments ?? []).map((a) => (
            <Chip key={a} hue="idle" title={a}>{a.split("/").pop()}</Chip>
          ))}
        </div>
      )}

      {/* action bar: the ONE "More ▾" menu + the ONE filled Send (Phase T —
          one primary per pane, all other lead actions inside More). */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
        <span className="min-w-2 flex-1" aria-hidden />
        {moreMenu}
        {/* a stale draft yields the primary weight to "Draft a fresh reply" above
            (tenet 17: one primary per pane) — Send still works, just quieter */}
        <Action variant={stale ? "neutral" : "primary"} onClick={sendNow} disabled={staging || !!revising}>
          {staging ? "Preparing…" : "Send…"}
        </Action>
      </div>
    </div>
  );
}

export function PackPreview({ file, onAttach, onEdit, onChanged, compact }: {
  file: string;
  onAttach?: (entryIndex: number, current: string[]) => void;
  onEdit?: (entryIndex: number, current: { subject: string; body: string; to: string }) => void;
  onChanged?: () => void; // packs list should refresh (staged marker cleared, etc.)
  compact?: boolean;
}) {
  const { pack, loading, reload } = usePack(file);
  const [revisingIdx, setRevisingIdx] = useState<{ i: number; instruction: string } | null>(null);
  const [diffBases, setDiffBases] = useState<Record<number, string>>({});
  const entries = entriesOf(pack);
  const baseFile = file.replace(/\.threaded\.json$/, ".json");
  if (loading && !pack) return <p className="py-3 text-center text-caption text-ink-dim">Loading draft…</p>;
  if (entries.length === 0) return <p className="py-3 text-center text-caption text-ink-dim">No drafts in this pack.</p>;
  return (
    <div className="flex flex-col gap-2.5">
      {entries.map((e, i) => {
        const atts = e.attachments ?? [];
        const revising = revisingIdx?.i === i ? revisingIdx.instruction : null;
        return (
          <div key={i} className={cx("rounded-card border border-line bg-fill-1", compact ? "p-2.5" : "p-3.5")}>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-body text-ink">{e.to_name || e.institution || "—"} <span className="text-ink-dim">· {e.to_email}</span></span>
              <div className="flex shrink-0 items-center gap-1.5">
                {e.lang && <TypeTag>{e.lang.toUpperCase()}</TypeTag>}
                {e.draft_type && <TypeTag>{humanType(e.draft_type)}</TypeTag>}
              </div>
            </div>
            <div className="mt-1.5 text-caption text-ink"><span className="text-ink-dim">Subject: </span>{e.subject || <span className="text-tone-bad-ink">— missing —</span>}</div>
            {!compact && (
              <div className="relative mt-1.5 rounded-ctl bg-well px-3 py-2">
                <DiffBody body={e.body ?? ""} base={revising ? null : (diffBases[i] ?? null)} dim={!!revising} inkClass="text-ink-dim"
                  summary={revising ? null : (e._revisions ?? [])[(e._revisions ?? []).length - 1]?.summary}
                  onDismiss={() => setDiffBases((d) => { const n = { ...d }; delete n[i]; return n; })} />
                {revising && (
                  <div className="absolute inset-0 grid place-items-center rounded-ctl" role="status" aria-label="Revising the draft">
                    <div className="max-w-[85%] rounded-card border border-accent/40 bg-fill-1 px-3 py-2 text-center"
                      style={{ animation: "breathe 1.8s var(--ease-soft) infinite" }}>
                      <div className="text-caption font-medium text-accent"><span aria-hidden>✦ </span>Revising this draft…</div>
                      <div className="mt-0.5 truncate text-caption text-ink-dim">“{revising}”</div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {compact && <Clamp text={e.body ?? ""} lines={2} className="mt-1 block text-caption text-ink-dim" />}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-caption text-ink-dim">Attaches:</span>
              {atts.length === 0
                ? <span className="text-caption text-ink-dim">nothing — what is listed here is what sends</span>
                : atts.map((a) => <TypeTag key={a} title={a}>{fname(a)}</TypeTag>)}
              {onAttach && <Action variant="ghost" onClick={() => onAttach(i, atts)}>{atts.length ? "Change" : "+ Attach"}</Action>}
              {onEdit && <Action variant="ghost" onClick={() => onEdit(i, { subject: e.subject ?? "", body: e.body ?? "", to: e.to_email ?? "" })}>✎ Edit</Action>}
            </div>
            {!compact && (
              <RevisionStrip file={baseFile} entry={i} revisions={e._revisions ?? []}
                onBusyChange={(busy, instruction) => {
                  if (busy) setDiffBases((d) => ({ ...d, [i]: e.body ?? "" }));
                  setRevisingIdx(busy ? { i, instruction: instruction ?? "" } : null);
                }}
                onApplied={() => { reload(); onChanged?.(); }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
