import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LIVE_OWNERSHIP, ownerOf } from "@/lib/ownership";
import { AGENT_BY_ID, type AgentId } from "@/lib/agents";
import { resolveBase, cadence } from "@/lib/systemd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every scheduled job on the box — systemd timers + the always-on / event-driven
// services agents own. Each entry carries description, schedule, cadence, owner,
// and last/next fire times. All from systemd.

const exec = promisify(execFile);
const stripSuffix = (u: string) => u.replace(/\.(timer|service)$/, "");
function ownerInfo(b: string) {
  const id = ownerOf(b) as AgentId | null;
  if (!id) return null;
  const a = AGENT_BY_ID[id];
  return a ? { id, name: a.name, color: a.color } : null;
}

export async function GET() {
  // 1. all loaded timers
  let timerBases: string[] = [];
  try {
    const { stdout } = await exec("systemctl", ["list-units", "--type=timer", "--all", "--no-legend", "--plain"], { timeout: 6000 });
    timerBases = stdout.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((u) => u.endsWith(".timer")).map(stripSuffix);
  } catch { /* */ }

  // 2. owned services that aren't timer-backed (always-on / event-driven)
  const ownedServiceBases = Object.values(LIVE_OWNERSHIP).flat().filter((b) => !timerBases.includes(b));

  const bases = [...timerBases, ...ownedServiceBases];
  const resolved = await Promise.all(bases.map((b) => resolveBase(b)));

  const jobs = resolved.flatMap((r, i) => {
    if (!r) return [];
    const b = bases[i];
    const owner = ownerInfo(b);
    return [{
      unit: r.unit, base: b, kind: r.kind, triggers: r.triggers,
      description: r.description, schedule: r.schedule.length ? r.schedule.join("  ·  ") : "—",
      cadence: cadence(r.schedule), persistent: r.persistent,
      owner, state: r.state, last: r.last, next: r.next, system: !owner,
    }];
  });

  jobs.sort((a, b2) => {
    if (a.system !== b2.system) return a.system ? 1 : -1;
    return (a.next ?? Infinity) - (b2.next ?? Infinity);
  });

  // distinct agent owners present (for the filter UI)
  const owners = Array.from(new Set(jobs.filter((j) => j.owner).map((j) => j.owner!.id)))
    .map((id) => { const a = AGENT_BY_ID[id as AgentId]; return { id, name: a.name, color: a.color }; });

  return NextResponse.json({
    ranAt: Date.now(),
    counts: { total: jobs.length, agent: jobs.filter((j) => !j.system).length, system: jobs.filter((j) => j.system).length },
    owners,
    jobs,
  });
}
