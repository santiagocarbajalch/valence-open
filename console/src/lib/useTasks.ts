"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/kit";

// THE BACKGROUND-WORK STATE (operator ruling 2026-07-13, after a gate-blocked
// group send failed invisibly): the machine's live job list, "what is it doing
// and did anything fail?". Truth lives on the server (/api/tasks, disk-backed
// job files); this hook only renders it and drives the work pill + overlay
// drawer (2026-07-17 shell port — the tray stopped being a flex sibling).
//
// Refresh-on-activity (doctrine): fetch on mount, on window focus, on the
// "velab:task-started" event (fired by pollJob whenever any job starts), and
// on a short interval ONLY while something is running. No idle timers.

export interface TaskRow {
  id: string;
  kind: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  running: boolean;
  ok: boolean | null;
  progress?: string;
  done?: number;
  total?: number;
  failure?: string;
  packFile?: string;
  view?: string;
}

function successWord(row: TaskRow): string {
  if (row.kind === "stage") return "Checks passed — the drafts are lined up in Gmail.";
  if (row.kind === "send") return `Send complete — ${row.progress ?? "all delivered"}.`;
  if (row.kind === "refresh") return "Board updated from Gmail.";
  return `Finished: ${row.title}`;
}

export interface TasksState {
  rows: TaskRow[];
  open: boolean;
  setOpen: (v: boolean) => void;
  dismiss: (id: string) => void;
  live: TaskRow[];
  attention: TaskRow[];
  doneRows: TaskRow[];
  running: number;
  failed: number;
  waiting: number;
  headline: string;
}

export function useTasks(): TasksState {
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [open, setOpen] = useState(false);
  const prev = useRef<Map<string, TaskRow>>(new Map());
  const firstLoad = useRef(true);
  const dead = useRef(false);
  useEffect(() => () => { dead.current = true; }, []);

  const load = useCallback(async () => {
    let next: TaskRow[];
    try {
      const d = (await fetch("/api/tasks").then((r) => r.json())) as { tasks?: TaskRow[] };
      next = d.tasks ?? [];
    } catch {
      return; // transient — keep the last known state rather than blanking it
    }
    if (dead.current) return;
    const now = new Map(next.map((r) => [r.id, r]));
    for (const [id, r] of now) {
      const before = prev.current.get(id);
      // a watched task finished cleanly → pop-up; a finished SEND also reloads
      // the board by itself (operator ruling: no manual refresh, ever)
      if (r.ok === true && before?.running) {
        toast(successWord(r), { tone: "ok" });
        if (r.kind === "send") window.dispatchEvent(new Event("velab:board-refresh"));
      }
      // a fresh failure opens the drawer — that is its entire purpose. On the
      // FIRST load we only seed state: a pre-existing failure leaves the
      // overlay closed (the sidebar pill shows it in red, one click away) so
      // the drawer never covers content the operator didn't ask to cover. A
      // failure that appears mid-session still pops it open.
      if (!firstLoad.current && r.ok === false && (!before || before.ok !== false)) setOpen(true);
    }
    firstLoad.current = false;
    prev.current = now;
    setRows(next);
  }, []);

  // mount + focus + task-start signal; interval only while something runs
  useEffect(() => {
    load();
    const onSignal = () => load();
    window.addEventListener("focus", onSignal);
    window.addEventListener("velab:task-started", onSignal);
    return () => {
      window.removeEventListener("focus", onSignal);
      window.removeEventListener("velab:task-started", onSignal);
    };
  }, [load]);
  const anyRunning = rows.some((r) => r.running);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const dismiss = useCallback(async (id: string) => {
    await fetch("/api/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "dismiss" }),
    }).catch(() => {});
    load();
  }, [load]);

  return useMemo(() => {
    const live = rows.filter((r) => r.running);
    const attention = rows.filter((r) => !r.running && (r.ok === false || r.kind === "staged-waiting"));
    const doneRows = rows.filter((r) => r.ok === true).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    const running = live.length;
    const failed = rows.filter((r) => r.ok === false).length;
    const waiting = rows.filter((r) => r.kind === "staged-waiting").length;
    const headline = [
      running > 0 ? `${running} running` : null,
      failed > 0 ? `${failed} failed` : null,
      waiting > 0 ? `${waiting} waiting on you` : null,
      doneRows.length > 0 ? `${doneRows.length} done` : null,
    ].filter(Boolean).join(" · ") || "idle";
    return { rows, open, setOpen, dismiss, live, attention, doneRows, running, failed, waiting, headline };
  }, [rows, open, dismiss]);
}
