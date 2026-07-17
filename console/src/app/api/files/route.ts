import fs from "node:fs";
import path from "node:path";
import { VAULT, safeUnder } from "@/lib/vault";
import { vaultOwnerOf } from "@/lib/vaultOwnership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Files tab's backend — a curated, read-mostly window onto the vault.
// Only the ROOTS below are reachable (each one is a "drive" in the navigator);
// every path is safeUnder-guarded against its root. Reads are whitelisted by
// extension; writes follow the proven /api/draft/file pattern: must pre-exist,
// ≤2MB, JSON-validated when the file is .json. This route never creates or
// deletes anything.

// One drive per owned area of the ownership manifest's map, so every cluster
// on the knowledge graph can land here. skipDirs hides machine exhaust
// (manifest migration rule 3: os/mirror, inbox/intel/corpus).
// readOnly drives are engine-regenerated: truth.py rewrites state/* on every
// derive and the archivist rewrites verdicts2/* on every run, so a hand-edit
// would report success and then silently vanish — the tenet-11 defect. The
// PUT below refuses them server-side; the UI hides the pencil.
const ROOTS: Record<string, { dir: string; label: string; skipDirs?: string[]; readOnly?: string }> = {
  companies: { dir: path.join(VAULT, "companies"), label: "Companies" },
  meetings: { dir: path.join(VAULT, "meetings"), label: "Meetings" },
  drafts: { dir: path.join(VAULT, "pipeline/drafts"), label: "Draft packs" },
  sent: { dir: path.join(VAULT, "pipeline/sent"), label: "Sent records" },
  outbox: { dir: path.join(VAULT, "pipeline/outbox"), label: "Outbox" },
  cadence: { dir: path.join(VAULT, "pipeline/cadence"), label: "Cadence" },
  audits: { dir: path.join(VAULT, "audits"), label: "Audits" },
  reference: { dir: path.join(VAULT, "reference"), label: "Reference" },
  leads: { dir: path.join(VAULT, "leads"), label: "Leads" },
  rfps: { dir: path.join(VAULT, "rfps"), label: "RFPs" },
  intel: { dir: path.join(VAULT, "inbox/intel"), label: "Inbox intelligence", skipDirs: ["corpus"] },
  state: { dir: path.join(VAULT, "state"), label: "Board & state", readOnly: "the truth engine rewrites these on every board refresh" },
  os: { dir: path.join(VAULT, "os"), label: "System", skipDirs: ["mirror"] },
  // the archivist's per-company "what's happening" summaries — kept as its own
  // drive so existing graph/file deep-links continue to resolve
  verdicts: { dir: path.join(VAULT, "inbox/intel/verdicts2"), label: "Company summaries", readOnly: "the Archivist rewrites these summaries on every run" },
  // assigned 2026-07-12 #3 (ownership manifest) — one drive per owned area
  clients: { dir: path.join(VAULT, "clients"), label: "Clients (legacy)" },
  suppression: { dir: path.join(VAULT, "suppression"), label: "Do-not-send lists" },
  metrics: { dir: path.join(VAULT, "metrics"), label: "Metrics" },
  plans: { dir: path.join(VAULT, "plans"), label: "Plans" },
  service: { dir: path.join(VAULT, "service"), label: "Service" },
};

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 500;
// text formats only — anything else is refused as "binary" (no ext whitelist hit)
const READABLE = new Set([".md", ".json", ".txt", ".jsonl", ".csv"]);

// noise the operator should never see in a file manager
function excluded(name: string, isDir: boolean): boolean {
  if (name.startsWith(".")) return true; // dotfiles (also covers .bak-* dirs)
  if (isDir) return name === "__pycache__" || name === "node_modules";
  if (name.endsWith(".pyc") || name.endsWith(".tmp")) return true;
  if (name.includes(".bak")) return true; // foo.json.bak, foo.md.bak-pre-x, …
  if (name.endsWith(".threaded.json")) return true; // show the base pack only
  return false;
}

export interface Entry {
  name: string;
  relPath: string;
  size: number;
  mtime: number;
  isDir: boolean;
  fileCount?: number; // dirs: recursive file count
  children?: Entry[];
}

// depth- and budget-bounded recursive listing; dirs first, then files, both A→Z
function walkDir(abs: string, rel: string, depth: number, budget: { left: number }, skipDirs?: string[]): { entries: Entry[]; files: number } {
  if (depth > MAX_DEPTH || budget.left <= 0) return { entries: [], files: 0 };
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return { entries: [], files: 0 };
  }
  dirents.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
  const entries: Entry[] = [];
  let files = 0;
  for (const d of dirents) {
    if (budget.left <= 0) break;
    const isDir = d.isDirectory();
    if (excluded(d.name, isDir)) continue;
    if (isDir && depth === 0 && skipDirs?.includes(d.name)) continue; // machine exhaust
    const childAbs = path.join(abs, d.name);
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (isDir) {
      budget.left--;
      const sub = walkDir(childAbs, childRel, depth + 1, budget, skipDirs);
      entries.push({ name: d.name, relPath: childRel, size: 0, mtime: 0, isDir: true, fileCount: sub.files, children: sub.entries });
      files += sub.files;
    } else {
      let st: fs.Stats;
      try { st = fs.statSync(childAbs); } catch { continue; }
      budget.left--;
      entries.push({ name: d.name, relPath: childRel, size: st.size, mtime: st.mtimeMs, isDir: false });
      files++;
    }
  }
  return { entries, files };
}

function buildTree(id: string) {
  const root = ROOTS[id];
  const budget = { left: MAX_ENTRIES };
  const { entries, files } = walkDir(root.dir, "", 0, budget, root.skipDirs);
  // owning agent per the canonical manifest (vault/os/ownership.md, read-only)
  const owner = vaultOwnerOf(path.relative(path.resolve(VAULT), path.resolve(root.dir)));
  return { id, label: root.label, owner, readOnly: root.readOnly ?? null, fileCount: files, truncated: budget.left <= 0, entries };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get("op") ?? "tree";

  if (op === "tree") {
    const rootId = url.searchParams.get("root");
    if (rootId) {
      if (!ROOTS[rootId]) return Response.json({ error: "unknown root" }, { status: 404 });
      return Response.json(buildTree(rootId));
    }
    // no root → all drives in one response (the navigator's initial load)
    return Response.json({ roots: Object.keys(ROOTS).map(buildTree) });
  }

  if (op === "read") {
    const rootId = url.searchParams.get("root") ?? "";
    const rel = url.searchParams.get("path") ?? "";
    const root = ROOTS[rootId];
    if (!root) return Response.json({ error: "unknown root" }, { status: 404 });
    const abs = safeUnder(root.dir, rel);
    if (!abs || abs === path.resolve(root.dir)) return Response.json({ error: "bad path" }, { status: 403 });
    const ext = path.extname(abs).toLowerCase();
    if (!READABLE.has(ext)) return Response.json({ error: "not a text file the console can open" }, { status: 415 });
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { return Response.json({ error: "not found" }, { status: 404 }); }
    if (!st.isFile()) return Response.json({ error: "not a file" }, { status: 400 });
    if (st.size > MAX_BYTES) return Response.json({ error: "file too large to open here (over 2 MB)" }, { status: 413 });
    try {
      return Response.json({
        root: rootId,
        path: rel,
        content: fs.readFileSync(abs, "utf8"),
        mtime: st.mtimeMs,
        size: st.size,
        ext: ext.slice(1),
      });
    } catch {
      return Response.json({ error: "unreadable" }, { status: 500 });
    }
  }

  return Response.json({ error: "unknown op" }, { status: 400 });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { root?: string; path?: string; content?: string };
  const root = ROOTS[body.root ?? ""];
  if (!root) return Response.json({ error: "unknown root" }, { status: 404 });
  if (root.readOnly) return Response.json({ error: `read-only — ${root.readOnly}` }, { status: 403 });
  const abs = safeUnder(root.dir, body.path ?? "");
  if (!abs || abs === path.resolve(root.dir)) return Response.json({ error: "bad path" }, { status: 403 });
  // companies pages keep the "Operator notes" section across regeneration, so they
  // stay editable — but INDEX.md has no such section and is fully rewritten.
  if (body.root === "companies" && (body.path === "INDEX.md" || body.path?.endsWith("/INDEX.md")))
    return Response.json({ error: "read-only — the truth engine rewrites INDEX.md on every board refresh" }, { status: 403 });
  if (typeof body.content !== "string") return Response.json({ error: "no content" }, { status: 400 });
  if (Buffer.byteLength(body.content) > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
  const ext = path.extname(abs).toLowerCase();
  if (!READABLE.has(ext)) return Response.json({ error: "not editable here" }, { status: 415 });
  if (!fs.existsSync(abs)) return Response.json({ error: "must pre-exist" }, { status: 404 }); // never create
  if (ext === ".json") {
    try { JSON.parse(body.content); } catch { return Response.json({ error: "that isn't valid JSON — fix it before saving" }, { status: 400 }); }
  }
  fs.writeFileSync(abs, body.content);
  return Response.json({ ok: true, mtime: fs.statSync(abs).mtimeMs });
}
