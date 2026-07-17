"use client";

import { useCallback, useRef, useState } from "react";
import type { AgentId } from "./agents";
import { AGENTS } from "./agents";

// REAL agent status — no fictional workflows. An agent is idle until a smoke
// test actually runs against its live artifacts; then it is "testing", then it
// settles to its real result (ok/warn/fail).
export type Level = "ok" | "warn" | "fail";
export type AgentStatus = "idle" | "testing" | Level;

export interface Check { label: string; level: Level; detail: string; }
export interface AgentReport {
  agent: AgentId;
  status: Level;
  summary: string;
  checks: Check[];
  headline: { label: string; value: string }[];
}

const idleMap = () =>
  Object.fromEntries(AGENTS.map((a) => [a.id, "idle" as AgentStatus])) as Record<AgentId, AgentStatus>;

export function useSmoke() {
  const [statuses, setStatuses] = useState<Record<AgentId, AgentStatus>>(idleMap);
  const [reports, setReports] = useState<Record<AgentId, AgentReport>>({} as Record<AgentId, AgentReport>);
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const busy = useRef(false);

  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    // visibly put every agent into "testing" (real run, no fake activity)
    setStatuses(Object.fromEntries(AGENTS.map((a) => [a.id, "testing"])) as Record<AgentId, AgentStatus>);
    try {
      const res = await fetch("/api/smoke", { cache: "no-store" });
      const data = (await res.json()) as { ranAt: number; reports: Record<AgentId, AgentReport> };
      setReports(data.reports);
      setRanAt(data.ranAt);
      // settle each agent to its real result, lightly staggered so you see it land
      const ids = AGENTS.map((a) => a.id);
      ids.forEach((id, i) => {
        setTimeout(() => {
          setStatuses((prev) => ({ ...prev, [id]: data.reports[id]?.status ?? "warn" }));
        }, 250 + i * 220);
      });
      setTimeout(() => { setRunning(false); busy.current = false; }, 250 + ids.length * 220);
    } catch {
      setStatuses(idleMap());
      setRunning(false);
      busy.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    setStatuses(idleMap());
    setReports({} as Record<AgentId, AgentReport>);
    setRanAt(null);
  }, []);

  return { statuses, reports, running, ranAt, run, reset };
}
