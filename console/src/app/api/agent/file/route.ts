import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read + write a single file belonging to an agent. WRITE is enabled for both the
// agent's core node files AND its realm data (operator's choice). Every path is
// validated to live INSIDE one of the agent's allowed roots — a traversal or a
// path outside those roots is rejected, so a UI bug can never write box-wide.

const V2_AGENTS = "/opt/velab/VenusV2/os/agents";
const VAULT = "/opt/velab/vault";
const V2 = "/opt/velab/VenusV2";
const MAX_WRITE = 2_000_000; // 2 MB ceiling per save

async function exists(p: string) { try { await fs.access(p); return true; } catch { return false; } }

async function frontmatterRealm(id: string): Promise<string> {
  try {
    const src = await fs.readFile(path.join(V2_AGENTS, id, "AGENT.md"), "utf8");
    const m = src.match(/^---\n([\s\S]*?)\n---/);
    const w = m?.[1].match(/^workspace:\s*(.*)$/m);
    if (w) return w[1].replace(/^["']|["']$/g, "").trim();
  } catch { /* */ }
  return id;
}

async function allowedRoots(id: string): Promise<string[]> {
  const roots = [path.join(V2_AGENTS, id)];
  const realm = await frontmatterRealm(id);
  for (const r of [path.join(VAULT, realm), path.join(V2, realm)]) {
    if (await exists(r)) roots.push(r);
  }
  return roots.map((r) => path.resolve(r));
}

// Validate that `full` resolves inside one of the agent's roots. Returns the
// safe resolved path or null.
async function safePath(id: string, full: string): Promise<string | null> {
  if (!/^[a-z][a-z0-9-]+$/.test(id) || !full) return null;
  const resolved = path.resolve(full);
  const roots = await allowedRoots(id);
  const ok = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  return ok ? resolved : null;
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const id = u.searchParams.get("id") ?? "";
  const full = u.searchParams.get("path") ?? "";
  const safe = await safePath(id, full);
  if (!safe) return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  try {
    const [content, st] = await Promise.all([fs.readFile(safe, "utf8"), fs.stat(safe)]);
    return NextResponse.json({ path: safe, content, mtime: st.mtimeMs, size: st.size });
  } catch {
    return NextResponse.json({ error: "read failed" }, { status: 404 });
  }
}

// Engine-regenerated targets: a write here reports success and is then silently
// rewritten by truth.py / pages.py / the Archivist. Refuse instead of lying.
// (companies/<key>.md keeps its "Operator notes" section, so those stay writable.)
function engineRegenerated(resolved: string): string | null {
  if (resolved.startsWith(path.join(VAULT, "state") + path.sep))
    return "the truth engine rewrites state files on every board refresh";
  if (resolved.startsWith(path.join(VAULT, "inbox/intel/verdicts2") + path.sep))
    return "the Archivist rewrites these summaries on every run";
  if (resolved === path.join(VAULT, "companies/INDEX.md"))
    return "the truth engine rewrites INDEX.md on every board refresh";
  return null;
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { id?: string; path?: string; content?: string };
  const safe = await safePath(body.id ?? "", body.path ?? "");
  if (!safe) return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  const regen = engineRegenerated(safe);
  if (regen) return NextResponse.json({ error: `read-only — ${regen}` }, { status: 403 });
  if (typeof body.content !== "string") return NextResponse.json({ error: "no content" }, { status: 400 });
  if (body.content.length > MAX_WRITE) return NextResponse.json({ error: "too large" }, { status: 413 });
  if (!(await exists(safe))) return NextResponse.json({ error: "file does not exist" }, { status: 404 });
  try {
    await fs.writeFile(safe, body.content, "utf8");
    const st = await fs.stat(safe);
    return NextResponse.json({ ok: true, path: safe, mtime: st.mtimeMs, size: st.size });
  } catch {
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
