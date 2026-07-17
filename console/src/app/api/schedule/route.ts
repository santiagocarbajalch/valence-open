import { NextResponse } from "next/server";
import { LIVE_OWNERSHIP, ownerOf } from "@/lib/ownership";
import { AGENT_BY_ID, type AgentId } from "@/lib/agents";
import { resolveBase, cadence, fireTimes } from "@/lib/systemd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A 24-hour fire schedule for the agent-owned jobs — the actual times each timer
// will fire over the next day, for the visual timeline in Health › Overview.
// High-frequency jobs (sub-30-min) are flagged instead of enumerated.

const WINDOW_SEC = 24 * 3600;
const HIGH_FREQ_SEC = 1800; // < 30 min ⇒ render as a continuous band, don't enumerate

export async function GET() {
  const bases = Object.values(LIVE_OWNERSHIP).flat();
  const now = Date.now();

  const jobs = (await Promise.all(bases.map(async (base) => {
    const r = await resolveBase(base);
    if (!r) return null;
    const cad = cadence(r.schedule);
    const id = ownerOf(base) as AgentId | null;
    const a = id ? AGENT_BY_ID[id] : null;
    const continuous = r.kind === "service" && r.schedule[0] === "always-on";
    const eventDriven = r.kind === "service" && r.schedule[0] === "event-driven";
    const highFreq = r.kind === "timer" && cad.approxSec > 0 && cad.approxSec < HIGH_FREQ_SEC;
    const fires = (r.kind === "timer" && !highFreq) ? await fireTimes(r.schedule, WINDOW_SEC) : [];
    return {
      base,
      owner: a ? { id, name: a.name, color: a.color } : null,
      kind: r.kind,
      state: r.state,
      cadence: cad,
      next: r.next,
      continuous, eventDriven, highFreq,
      fires,
    };
  }))).filter(Boolean);

  // sort: enumerable timers first (by cadence), then high-freq, then services
  jobs.sort((x, y) => {
    const rank = (j: NonNullable<typeof x>) => j!.eventDriven ? 3 : j!.continuous ? 2 : j!.highFreq ? 1 : 0;
    return rank(x!) - rank(y!) || (x!.cadence.approxSec - y!.cadence.approxSec);
  });

  return NextResponse.json({ now, windowSec: WINDOW_SEC, jobs });
}
