import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LIVE_OWNERSHIP } from "@/lib/ownership";
import { resolveBase, cadence, journal } from "@/lib/systemd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-agent dossier for the Team › Org-chart card. Everything here is read from
// disk + systemd truth — no simulation:
//   • meta        — name / role / jurisdiction / purpose, from AGENT.md frontmatter+body
//   • crons       — units the agent DECLARES (HEARTBEAT.md table) ∪ units it OWNS live
//                   (curated map below), each resolved to real systemd state + schedule
//   • files       — core node files (its definition) + realm data files (live vault or staging)
//   • activity    — recent journal lines from owned live units + recent file changes

const V2_AGENTS = "/opt/velab/VenusV2/os/agents";
const VAULT = "/opt/velab/vault";
const V2 = "/opt/velab/VenusV2";
const REALM_CAP = 60;

interface Leaf { name: string; rel: string; full: string; mtime: number; size: number; }

async function walk(dir: string, base: string, depth = 0, acc: Leaf[] = []): Promise<Leaf[]> {
  if (depth > 3) return acc;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === "node_modules") continue; await walk(full, base, depth + 1, acc); }
    else {
      let mtime = 0, size = 0;
      try { const st = await fs.stat(full); mtime = st.mtimeMs; size = st.size; } catch { /* */ }
      acc.push({ name: e.name, rel: path.relative(base, full), full, mtime, size });
    }
  }
  return acc;
}
async function exists(p: string) { try { await fs.access(p); return true; } catch { return false; } }

function frontmatter(src: string): Record<string, string> {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}
function purposeOf(src: string): string {
  const body = src.replace(/^---\n[\s\S]*?\n---\n?/, "");
  // first non-empty paragraph after the first heading
  const afterHeading = body.replace(/^#.*$/m, "");
  const para = afterHeading.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#"));
  return (para ?? "").replace(/\s+/g, " ").slice(0, 420);
}

// Parse the HEARTBEAT.md table → declared units + their "what it does" cell.
function declaredUnits(heartbeat: string): { name: string; desc: string }[] {
  const out: { name: string; desc: string }[] = [];
  for (const raw of heartbeat.split("\n")) {
    if (!raw.trim().startsWith("|")) continue;
    const cells = raw.split("|").map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 2) continue;
    const name = cells[0];
    if (!/^[a-z][a-z0-9-]+$/.test(name)) continue; // skip header/separator rows
    out.push({ name, desc: cells[cells.length - 1] });
  }
  return out;
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id")?.trim() ?? "";
  if (!/^[a-z][a-z0-9-]+$/.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const nodeDir = path.join(V2_AGENTS, id);
  if (!(await exists(nodeDir))) return NextResponse.json({ error: "no such agent node", id }, { status: 404 });

  // ---- meta ----
  let agentMd = ""; try { agentMd = await fs.readFile(path.join(nodeDir, "AGENT.md"), "utf8"); } catch { /* */ }
  let heartbeatMd = ""; try { heartbeatMd = await fs.readFile(path.join(nodeDir, "HEARTBEAT.md"), "utf8"); } catch { /* */ }
  const fm = frontmatter(agentMd);
  const realm = fm.workspace || id;
  const meta = {
    id,
    name: fm.name || id,
    color: fm.color || "#9aa6b8",
    glyph: fm.glyph || (fm.name || id)[0].toUpperCase(),
    tagline: fm.tagline || "",
    purpose: purposeOf(agentMd),
    realm,
  };

  // ---- files ----
  const nodeFiles = (await walk(nodeDir, nodeDir)).sort((a, b) => {
    const rank = (n: string) => (n === "AGENT.md" ? 0 : n === "CONTEXT.md" ? 1 : n === "HEARTBEAT.md" ? 2 : 3);
    return rank(a.name) - rank(b.name) || a.rel.localeCompare(b.rel);
  });
  const realmLivePath = path.join(VAULT, realm);
  const realmStagePath = path.join(V2, realm);
  const realmLive = await exists(realmLivePath);
  const realmRoot = realmLive ? realmLivePath : (await exists(realmStagePath) ? realmStagePath : null);
  let realmAll: Leaf[] = [];
  if (realmRoot) {
    realmAll = (await walk(realmRoot, realmRoot)).sort((x, y) => {
      const xm = x.name.endsWith(".md") ? 1 : 0, ym = y.name.endsWith(".md") ? 1 : 0;
      return ym - xm || y.mtime - x.mtime;
    });
  }
  const realmFiles = realmAll.slice(0, REALM_CAP);

  // ---- crons ----
  const declared = declaredUnits(heartbeatMd);
  const owned = LIVE_OWNERSHIP[id] ?? [];
  const names = Array.from(new Set([...declared.map((d) => d.name), ...owned]));
  const descByName = new Map(declared.map((d) => [d.name, d.desc]));
  const crons = await Promise.all(names.map(async (name) => {
    const live = await resolveBase(name);
    // description: HEARTBEAT table wins; fall back to the systemd unit Description
    const desc = descByName.get(name) || live?.description || "";
    return {
      name,
      desc,
      schedule: live ? (live.schedule.length ? live.schedule.join("  ·  ") : "—") : "—",
      cadence: live ? cadence(live.schedule) : { label: "not scheduled", approxSec: Number.MAX_SAFE_INTEGER },
      declared: descByName.has(name),
      owned: owned.includes(name),
      unit: live?.unit ?? null,
      state: live?.state ?? "absent",
      last: live?.last ?? null,
      next: live?.next ?? null,
    };
  }));
  crons.sort((a, b) => (b.state !== "absent" ? 1 : 0) - (a.state !== "absent" ? 1 : 0) || a.name.localeCompare(b.name));

  // ---- activity ----
  // Prefer the .service journal (the actual work) over the .timer journal (just
  // scheduling noise) for any unit that resolved live.
  const liveUnits = crons.filter((c) => c.unit).map((c) => `${c.name}.service`);
  const journalChunks = await Promise.all(liveUnits.map((u) => journal(u, 5)));
  const fileChanges = [...nodeFiles, ...realmFiles]
    .filter((f) => f.mtime)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 8)
    .map((f) => ({ ts: f.mtime, source: "file", text: `updated ${f.rel}` }));
  const activity = [...journalChunks.flat(), ...fileChanges]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 24);

  return NextResponse.json({
    ranAt: Date.now(),
    meta,
    realmLive,
    realmRoot,
    crons,
    files: {
      core: nodeFiles.map((f) => ({ name: f.name, rel: f.rel, full: f.full, mtime: f.mtime, size: f.size })),
      realm: realmFiles.map((f) => ({ name: f.name, rel: f.rel, full: f.full, mtime: f.mtime, size: f.size })),
      realmTotal: realmAll.length,
    },
    activity,
  });
}
