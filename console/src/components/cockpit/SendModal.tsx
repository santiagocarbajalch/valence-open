"use client";

import { useEffect, useState } from "react";
import { Modal, Action, toast } from "@/components/kit";
import { PackPreview } from "./PackPreview";

// The guarded SEND modal — V5 (operator decision 2026-07-10): one confirmed
// click replaces the typed verbatim approval. It still SHOWS exactly what is
// being approved (recipients + drafted content + attachments via PackPreview),
// and EVERY server-side layer is unchanged — the click submits the standalone
// approval word "send", which the guardrail, grant ticket, caps, and scrubs
// all still verify. With send enabled, a clean approval mints a grant + runs
// the detached batch sender and this polls it.

interface Pack { file: string; label: string; count: number; recipients: string[] }
interface JobSt { running: boolean; code: number | null; out: string; err: string }

export function SendModal({ pack, onClose, onDone }: { pack: Pack; onClose: () => void; onDone: () => void }) {
  const [resp, setResp] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobSt | null>(null);

  const submit = async () => {
    setBusy(true); setResp(null);
    const res = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: pack.file, approval: "send", confirm: pack.count }) });
    const d = await res.json();
    setResp(d);
    if (d.jobId) { setJobId(d.jobId); toast("Send authorized — dispatching…", { tone: "warn" }); }
    setBusy(false);
  };

  useEffect(() => {
    if (!jobId) return;
    const t = setInterval(async () => {
      const d = (await fetch(`/api/job?id=${jobId}`).then((r) => r.json())) as JobSt;
      setJob(d);
      if (!d.running) { clearInterval(t); toast(d.code === 0 ? "✓ Batch sent" : "Send finished with errors — check the log", { tone: d.code === 0 ? "ok" : "bad" }); onDone(); }
    }, 3000);
    return () => clearInterval(t);
  }, [jobId, onDone]);

  const blocked = resp && resp.ok === false && (resp.blocked || resp.error);
  const dark = resp && resp.dark === true;
  const jobDone = job && !job.running;
  const jobFailed = jobDone && job.code !== 0;
  const jobOk = jobDone && job.code === 0;

  return (
    <Modal title={<>Send · {pack.label}</>} onClose={onClose} wide
      footer={<>
        <Action variant="neutral" onClick={onClose}>Cancel</Action>
        <button onClick={submit} disabled={busy || !!jobId} className="rounded-lg px-4 py-1.5 text-caption font-medium text-ink-on-vivid disabled:opacity-40" style={{ background: "var(--c-mailman)" }}>{busy ? "checking…" : `▸ Send to ${pack.count} inbox${pack.count !== 1 ? "es" : ""} now`}</button>
      </>}>
      <p className="mb-2 text-caption text-ink-dim">
        <b className="text-tone-warn-ink">Sending is final.</b> Review below — this really leaves for {pack.count} real inbox{pack.count !== 1 ? "es" : ""} when you press Send.
      </p>

      {/* what is being sent */}
      <div className="mb-3 rounded-xl border border-white/8 bg-black/20 p-2">
        <div className="mb-1 px-1 text-caption font-medium text-ink-dim">You are sending</div>
        <PackPreview file={pack.file} compact />
      </div>

      {resp && (
        <div role="status" aria-live="polite" className={`mt-3 rounded-xl border px-3 py-2 text-caption ${dark ? "border-tone-warn/40 bg-tone-warn/[0.06] text-tone-warn-ink" : blocked || jobFailed ? "border-tone-bad/40 bg-tone-bad/[0.06] text-tone-bad-ink" : "border-tone-ok/40 bg-tone-ok/[0.06] text-tone-ok-ink"}`}>
          {dark ? (
            <><b>Dark.</b> {String(resp.reason)}</>
          ) : blocked ? (
            <><b>Blocked ({String(resp.blocked ?? "error")}).</b> {String(resp.reason ?? resp.error)}</>
          ) : jobFailed ? (
            <>✕ <b>Send failed (exit {String(job!.code)}).</b> Nothing was delivered — check the log below.</>
          ) : jobOk ? (
            <>✓ <b>Batch sent.</b> job {jobId} exited cleanly.</>
          ) : (
            <>✓ <b>Granted.</b> {jobId ? `Sending (job ${jobId})…` : "ticket minted."}</>
          )}
          {Array.isArray(resp.meetingConfirms) && (resp.meetingConfirms as { ok: boolean; error?: string }[]).length > 0 && (
            <div className="mt-1">
              {(resp.meetingConfirms as { ok: boolean; error?: string }[]).map((m, i) =>
                m.ok
                  ? <div key={i}>✓ Calendar invite sent — the held meeting time is now official.</div>
                  : <div key={i} className="text-tone-warn-ink">⚠ Held meeting found but the calendar invite failed: {m.error}. Send it from Google Calendar.</div>,
              )}
            </div>
          )}
        </div>
      )}
      {job && <pre className="thin-scroll mt-2 max-h-40 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-micro text-ink-dim">{job.out.slice(-1200) || "…"}{job.err ? `\n[err] ${job.err.slice(-400)}` : ""}{job.running ? "\n…running" : `\n[exit ${job.code}]`}</pre>}
    </Modal>
  );
}
