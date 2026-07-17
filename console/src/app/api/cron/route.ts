import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { LIVE_OWNERSHIP, ownerOf } from "@/lib/ownership";
import { AGENT_BY_ID, type AgentId } from "@/lib/agents";
import { resolveBase, cadence, journal, showUnit } from "@/lib/systemd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Detail for a single scheduled job: full schedule + timing, the systemd unit
// file contents (timer + triggered service), and recent journal logs.

function ownerInfo(b: string) {
  const id = ownerOf(b) as AgentId | null;
  if (!id) return null;
  const a = AGENT_BY_ID[id];
  return a ? { id, name: a.name, color: a.color } : null;
}

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("unit")?.trim() ?? "";
  if (!/^[a-z][a-z0-9.@-]+$/i.test(raw)) return NextResponse.json({ error: "bad unit" }, { status: 400 });
  const base = raw.replace(/\.(timer|service)$/, "");

  const r = await resolveBase(base);
  if (!r) return NextResponse.json({ error: "unit not loaded", base }, { status: 404 });

  // unit file contents: the timer (if any) + the triggered/own service
  const files: { unit: string; path: string; content: string }[] = [];
  const addFile = async (unit: string, path: string) => {
    if (!path) return;
    try { files.push({ unit, path, content: await fs.readFile(path, "utf8") }); } catch { /* */ }
  };
  if (r.kind === "timer") {
    await addFile(r.unit, r.fragmentPath);
    const svc = r.triggers || `${base}.service`;
    const skv = await showUnit(svc, ["FragmentPath"]);
    await addFile(svc, skv.FragmentPath || "");
  } else {
    await addFile(r.unit, r.fragmentPath);
  }

  // logs: timer + service journals, merged newest-first
  const logUnits = r.kind === "timer" ? [r.unit, r.triggers || `${base}.service`] : [r.unit];
  const logChunks = await Promise.all(logUnits.map((u) => journal(u, 30)));
  const logs = logChunks.flat().sort((a, b) => b.ts - a.ts).slice(0, 60);

  return NextResponse.json({
    ranAt: Date.now(),
    base,
    unit: r.unit,
    kind: r.kind,
    triggers: r.triggers,
    description: r.description,
    schedule: r.schedule,
    cadence: cadence(r.schedule),
    persistent: r.persistent,
    state: r.state,
    last: r.last,
    next: r.next,
    owner: ownerInfo(base),
    system: !ownerInfo(base) && !Object.values(LIVE_OWNERSHIP).flat().includes(base),
    files,
    logs,
  });
}
