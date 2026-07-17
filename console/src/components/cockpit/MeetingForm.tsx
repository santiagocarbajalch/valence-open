"use client";

import { useState } from "react";
import { Modal, Action } from "@/components/kit";

// Schedule a Google Meet (create_meeting.py, OAuth-as-Robert). Honors the two-phase
// rule: this HOLDS the event (sendUpdates=none) and mints the link to embed in the
// reply — the calendar INVITE fires later, with the email, at send-GO (confirm).
// With an open draft (`draft`), the hold binds to it: the server writes the Meet
// link into the body and stamps the event on the entry — no copy-paste step.
interface Row { domain: string; who: string; people: string[] }

export function MeetingForm({ row, draft, onClose, onChanged }: { row: Row; draft?: { file: string } | null; onClose: () => void; onChanged?: () => void }) {
  const [summary, setSummary] = useState(`VELAB × ${row.domain}`);
  const [start, setStart] = useState("");
  const [duration, setDuration] = useState(30);
  const [attendees, setAttendees] = useState((row.people[0] ?? row.who ?? "") + ",sales@example.com");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Record<string, unknown> | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const create = async () => {
    setBusy(true);
    setRes(null);
    const r = await fetch("/api/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        summary,
        start,
        durationMin: duration,
        attendees: attendees.split(",").map((s) => s.trim()).filter(Boolean),
        ...(draft?.file ? { draftFile: draft.file } : {}),
      }),
    }).then((x) => x.json());
    setRes(r);
    setBusy(false);
    if (r.ok) onChanged?.(); // the hold is now in the meetings registry — refresh the board
  };

  // undo the hold just created — silent (nobody was notified of a held time)
  const cancelHold = async () => {
    if (!res?.event_id) return;
    setBusy(true);
    const r = await fetch("/api/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", eventId: String(res.event_id) }),
    }).then((x) => x.json());
    setBusy(false);
    if (r.ok) { setCancelled(true); onChanged?.(); }
    else setRes({ ...res, cancel_error: r.error ?? "cancel failed" });
  };

  return (
    <Modal title={<>Schedule Meet · {row.domain}</>} onClose={onClose} dirty={!!start}
      footer={<>
        <Action variant="neutral" onClick={onClose}>Close</Action>
        <button onClick={create} disabled={busy || !start} className="rounded-lg px-4 py-1.5 text-caption font-medium text-ink-on-vivid disabled:opacity-40" style={{ background: "var(--c-steward)" }}>{busy ? "holding the time…" : "Hold the time + create Meet link"}</button>
      </>}>
        <div className="flex flex-col gap-2.5 text-caption">
          <label className="text-ink-faint">Title<input value={summary} onChange={(e) => setSummary(e.target.value)} className="mt-1 w-full rounded-lg border border-white/12 bg-black/30 px-3 py-1.5 text-ink outline-none focus:border-white/25" /></label>
          <div className="flex gap-2">
            <label className="flex-1 text-ink-faint">Start (local, US Central)<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 w-full rounded-lg border border-white/12 bg-black/30 px-3 py-1.5 text-ink outline-none focus:border-white/25" /></label>
            <label className="w-24 text-ink-faint">Min<input type="number" value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/12 bg-black/30 px-3 py-1.5 text-ink outline-none focus:border-white/25" /></label>
          </div>
          <label className="text-ink-faint">Attendees (csv)<input value={attendees} onChange={(e) => setAttendees(e.target.value)} className="mt-1 w-full rounded-lg border border-white/12 bg-black/30 px-3 py-1.5 text-ink outline-none focus:border-white/25" /></label>
        </div>
        {res && (
          <div className={`mt-3 rounded-xl border px-3 py-2 text-caption ${res.ok ? "border-tone-ok/40 bg-tone-ok/[0.06] text-tone-ok-ink" : "border-tone-bad/40 bg-tone-bad/[0.06] text-tone-bad-ink"}`}>
            {cancelled ? <>
              Hold cancelled — the time is off the calendar. Nobody was ever notified.
            </> : res.ok ? <>
              ✓ Time held. Meet link: <a href={String(res.meet_url)} target="_blank" className="underline">{String(res.meet_url)}</a>
              <br /><span className="text-ink-faint">Nobody has been notified yet — the calendar invite goes out when you approve the send.</span>
              {res.draftUpdated === true && <><br /><span>✓ The link and time were written into your draft reply — review it before sending (it needs a fresh staging).</span></>}
              {typeof res.draftError === "string" && <><br /><span className="text-tone-warn-ink">⚠ {res.draftError}</span></>}
              {typeof res.cancel_error === "string" && <><br /><span className="text-tone-warn-ink">⚠ Couldn&apos;t cancel the hold: {res.cancel_error}</span></>}
              <div className="mt-1.5">
                <button onClick={cancelHold} disabled={busy} className="rounded-lg border border-tone-bad/40 px-2.5 py-1 text-micro text-tone-bad-ink hover:bg-tone-bad/10 disabled:opacity-40">
                  {busy ? "cancelling…" : "Cancel this hold"}
                </button>
              </div>
              <details className="mt-1 text-ink-faint">
                <summary className="cursor-pointer">Technical details</summary>
                <span>calendar event {String(res.event_id)}</span>
              </details>
            </> : <>⚠ {String(res.error)}</>}
          </div>
        )}
        <p className="mt-2 text-micro text-ink-dim">
          {draft?.file
            ? "Holding a time notifies no one. The Meet link is written into your draft reply for you — the calendar invite goes out together with the email when you approve the send."
            : "Holding a time notifies no one. Put the Meet link in your reply — when a reply is drafted the link rides it, and the calendar invite goes out together with the email when you approve the send."}
        </p>
    </Modal>
  );
}
