"use client";

import { jobOk } from "@/lib/jobResult";

// Poll a detached console job (/api/job) until it finishes. Returns a cancel fn.
// ok = exit 0 AND the tool's RESULT line (if any) says ok:true — ONE rule,
// shared with the server task list via lib/jobResult (never re-derive it).
//
// Starting a poll also announces the job to the task tray ("velab:task-started")
// so the tray picks it up immediately instead of on its next scheduled fetch.
export function pollJob(
  id: string,
  onDone: (ok: boolean, out: string) => void,
  intervalMs = 5000,
): () => void {
  try { window.dispatchEvent(new Event("velab:task-started")); } catch { /* no window */ }
  const t = setInterval(async () => {
    try {
      const st = (await fetch(`/api/job?id=${id}`).then((r) => r.json())) as { running: boolean; code: number | null; out?: string };
      if (st.running) return;
      clearInterval(t);
      const out = st.out ?? "";
      onDone(jobOk(st.code, out), out);
    } catch { /* transient; keep polling */ }
  }, intervalMs);
  return () => clearInterval(t);
}
