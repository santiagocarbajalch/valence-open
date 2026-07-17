import { NextResponse } from "next/server";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { AGENTS, EXTRA_IDENTITY, DEFAULT_AGENT_COLOR } from "@/lib/agents";
import { VAULT } from "@/lib/vault";
import { BOARD_FILE, companyKey } from "@/lib/pipeline";
import { loadOwnership } from "@/lib/vaultOwnership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TWO lenses over the same vault — the STRUCTURE is the default:
//
//   mode=agents (DEFAULT) — the agent-rooted routing map. This is Valence's
//   chassis: the central valence node, each agent node with its definition
//   files (AGENT/CONTEXT/HEARTBEAT/processes in VenusV2/os/agents/<id>/),
//   and the realm data each agent owns. Orders route DOWN this tree;
//   heartbeats fire WITHIN a node. Never remove this view — it is how
//   information routes. OWNERSHIP FACTS come from the canonical manifest
//   vault/os/ownership.md (operator-owned, read-only to tools); lib/agents.ts
//   contributes visual identity (colors) only.
//
//   mode=companies — a work lens: actionable companies from the certified
//   board and their real artifacts (page, meetings, packs, verdicts), with
//   click-through into the Files tab. A projection, not the structure.

// ───────────────────────── mode=agents (the structure) ─────────────────────────

const V2 = "/opt/velab/VenusV2";
const REALM_SAMPLE = 13;
const WIKILINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
const norm = (s: string) => s.trim().toLowerCase().replace(/\.[a-z]+$/, "").replace(/[\s_]+/g, "-");

interface Leaf { name: string; full: string; mtime: number; }

async function walk(dir: string, depth = 0, acc: Leaf[] = [], skip?: Set<string>): Promise<Leaf[]> {
  if (depth > 3) return acc;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || skip?.has(full)) continue;
      await walk(full, depth + 1, acc, skip);
    } else {
      let mtime = 0;
      try { mtime = (await fsp.stat(full)).mtimeMs; } catch { /* */ }
      acc.push({ name: e.name, full, mtime });
    }
  }
  return acc;
}
async function exists(p: string) { try { await fsp.access(p); return true; } catch { return false; } }
const pretty = (n: string) => n.replace(/\.(md|json|jsonl|txt|py|js|prompt)$/g, "").replace(/[-_]/g, " ").slice(0, 30);

async function agentGraph() {
  type Node = { id: string; label: string; kind: "agent" | "file"; source?: "node" | "realm"; color: string; central?: boolean; parent?: string; realmCount?: number; realmLive?: boolean };
  type Link = { source: string; target: string; kind: "command" | "node" | "owns" | "link" };

  const nodes: Node[] = [];
  const links: Link[] = [];
  const slugToId = new Map<string, string>();
  const mdFiles: { id: string; full: string }[] = [];

  // roster = the MANIFEST's agents (ownership facts). lib/agents.ts and
  // EXTRA_IDENTITY contribute presentation only (color, central flag).
  const manifest = loadOwnership();
  const roster = manifest.agents.map((m) => {
    const id = m.agent.toLowerCase();
    const vis = AGENTS.find((x) => x.id === id);
    return {
      id,
      name: m.agent,
      paths: m.paths,
      color: vis?.color ?? EXTRA_IDENTITY[id]?.color ?? DEFAULT_AGENT_COLOR,
      central: id === "valence",
    };
  });
  const valence = roster.find((r) => r.central) ?? roster[0];
  if (!valence) {
    // manifest missing/unreadable — surface that plainly instead of guessing
    return NextResponse.json({ error: "ownership manifest unreadable (vault/os/ownership.md)" }, { status: 502 });
  }
  // machine exhaust never counts as knowledge (manifest migration rule 3)
  const EXHAUST = new Set(["os/mirror", "inbox/intel/corpus"].map((p) => path.join(VAULT, p)));

  for (const a of roster) {
    // 1. node files (the agent's definition — AGENT/CONTEXT/HEARTBEAT/processes)
    const nodeDir = path.join(V2, "os/agents", a.id);
    const nodeFiles = await walk(nodeDir);
    // 2. realm data — every vault dir the manifest assigns to this agent
    let realmAll: Leaf[] = [];
    let liveAny = false;
    for (const rel of a.paths) {
      const abs = path.join(VAULT, rel);
      if (await exists(abs)) {
        liveAny = true;
        realmAll = await walk(abs, 0, realmAll, EXHAUST);
      }
    }
    realmAll.sort((x, y) => {
      const xm = x.name.endsWith(".md") ? 1 : 0, ym = y.name.endsWith(".md") ? 1 : 0;
      return ym - xm || y.mtime - x.mtime;
    });

    nodes.push({
      id: a.id, label: a.name, kind: "agent", color: a.color, central: a.central,
      realmCount: realmAll.length, realmLive: liveAny,
    });
    if (!a.central) links.push({ source: valence.id, target: a.id, kind: "command" });

    const addFile = (f: Leaf, idx: number, src: "node" | "realm") => {
      const fid = `${a.id}:${src}:${idx}`;
      nodes.push({ id: fid, label: pretty(f.name), kind: "file", source: src, color: a.color, parent: a.id });
      links.push({ source: a.id, target: fid, kind: src === "node" ? "node" : "owns" });
      slugToId.set(norm(f.name), fid);
      if (f.name.endsWith(".md")) mdFiles.push({ id: fid, full: f.full });
    };
    // ALWAYS include the node files (the truth), then a realm sample
    nodeFiles.forEach((f, i) => addFile(f, i, "node"));
    realmAll.slice(0, REALM_SAMPLE).forEach((f, i) => addFile(f, i, "realm"));
  }

  // markdown [[wikilinks]] among sampled files
  const seen = new Set<string>();
  await Promise.all(mdFiles.map(async ({ id, full }) => {
    let text = ""; try { text = await fsp.readFile(full, "utf8"); } catch { return; }
    let m: RegExpExecArray | null; WIKILINK.lastIndex = 0;
    while ((m = WIKILINK.exec(text))) {
      const tgt = slugToId.get(norm(m[1]));
      if (tgt && tgt !== id) {
        const key = id < tgt ? `${id}|${tgt}` : `${tgt}|${id}`;
        if (!seen.has(key)) { seen.add(key); links.push({ source: id, target: tgt, kind: "link" }); }
      }
    }
  }));

  const agentNodes = nodes.filter((n) => n.kind === "agent");
  return NextResponse.json({
    ranAt: Date.now(),
    mode: "agent-rooted-truth",
    stats: {
      agents: roster.length,
      realmFiles: agentNodes.reduce((s, n) => s + (n.realmCount ?? 0), 0),
      shownFiles: nodes.filter((n) => n.kind === "file").length,
      crossLinks: seen.size,
      unshipped: agentNodes.filter((n) => !n.realmLive).map((n) => n.label),
    },
    nodes,
    links,
  });
}

// ──────────────────────── mode=companies (a work lens) ────────────────────────

interface BoardCompany { key?: string; bucket?: string; state?: string; class?: string; suppressed?: string }
interface BoardFile { companies?: BoardCompany[]; suppressed_engaged?: BoardCompany[] }

type Tone = "ok" | "warn" | "bad" | "info" | "dim";
interface GNode {
  id: string;
  label: string;
  kind: "company" | "file";
  tone: Tone;
  bucket?: string;
  stateText?: string; // plain language: "needs a reply", "waiting on them", …
  ftype?: "page" | "meeting" | "draft" | "verdict";
  parent?: string;
  root?: string; // Files-tab root id — click-through target
  relPath?: string;
  fileCount?: number;
  tip: string;
}
interface GLink { source: string; target: string; kind: "owns" | "link" }

const ACTIONABLE = new Set(["owe", "owe-review", "awaiting", "institutional"]);
const BUCKET_TONE: Record<string, Tone> = { owe: "bad", "owe-review": "warn", awaiting: "info", institutional: "dim", frozen: "dim" };
const BUCKET_TEXT: Record<string, string> = {
  owe: "needs a reply",
  "owe-review": "needs a look",
  awaiting: "waiting on them",
  institutional: "institutional thread",
  frozen: "paused (frozen)",
};
const MAX_PER_KIND = 5; // meeting/draft artifacts per company — most recent first

function listFiles(dir: string): { name: string; abs: string; mtime: number }[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: { name: string; abs: string; mtime: number }[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isFile()) out.push({ name, abs, mtime: st.mtimeMs });
  }
  return out;
}

// does a meeting filename like "2026-06-24-acme-labs-sac.md" belong to key "acme-labs.example.com"?
function meetingMatches(fileName: string, key: string): boolean {
  const base = fileName.toLowerCase().replace(/\.md$/, "");
  if (base.includes(key)) return true;
  const slug = base.replace(/^\d{4}-\d{2}-\d{2}-/, ""); // drop the date prefix
  const label = key.split(".")[0]; // registrable domain's first label
  if (label.length < 4 || slug.length < 4) return false;
  return slug.startsWith(label) || label.startsWith(slug);
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function companyGraph() {
  let board: BoardFile;
  try {
    board = JSON.parse(fs.readFileSync(BOARD_FILE, "utf8")) as BoardFile;
  } catch {
    return Response.json({ error: "board.json unreadable" }, { status: 502 });
  }

  const companies: { key: string; bucket: string; state?: string }[] = [];
  for (const c of board.companies ?? []) {
    if (c.key && ACTIONABLE.has(c.bucket ?? "")) companies.push({ key: c.key, bucket: c.bucket!, state: c.state });
  }
  for (const c of board.suppressed_engaged ?? []) {
    if (c.key) companies.push({ key: c.key, bucket: "frozen" });
  }

  // meeting notes across all state folders (scheduled/held/proposed/…)
  const meetingFiles: { rel: string; name: string; mtime: number }[] = [];
  const meetingsDir = path.join(VAULT, "meetings");
  let stateDirs: string[] = [];
  try { stateDirs = fs.readdirSync(meetingsDir).filter((d) => !d.startsWith(".")); } catch { /* absent */ }
  for (const sd of stateDirs) {
    const abs = path.join(meetingsDir, sd);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of listFiles(abs)) {
      if (f.name.endsWith(".md")) meetingFiles.push({ rel: `${sd}/${f.name}`, name: f.name, mtime: f.mtime });
    }
  }

  // draft packs → which company keys each pack addresses (to_email domains)
  const keySet = new Set(companies.map((c) => c.key));
  const packHits = new Map<string, { rel: string; date: string; mtime: number }[]>();
  const draftsDir = path.join(VAULT, "pipeline/drafts");
  for (const f of listFiles(draftsDir)) {
    if (!f.name.endsWith(".json") || f.name.endsWith(".threaded.json")) continue;
    let pack: { date?: string; drafts?: { to_email?: string }[] };
    try {
      if (fs.statSync(f.abs).size > 2 * 1024 * 1024) continue;
      pack = JSON.parse(fs.readFileSync(f.abs, "utf8"));
    } catch { continue; }
    const hitKeys = new Set<string>();
    for (const d of pack.drafts ?? []) {
      if (!d.to_email) continue;
      // key exactly like the engine (identity.py port) — freemail leads key by
      // full mailbox, company leads by registrable domain
      const k = companyKey(d.to_email);
      if (keySet.has(k)) hitKeys.add(k);
    }
    for (const k of hitKeys) {
      const arr = packHits.get(k) ?? [];
      arr.push({ rel: f.name, date: pack.date ?? "", mtime: f.mtime });
      packHits.set(k, arr);
    }
  }

  const nodes: GNode[] = [];
  const links: GLink[] = [];
  const pageText = new Map<string, string>(); // key → company page markdown (for wikilinks + label)
  let fileNodes = 0;

  for (const c of companies) {
    const tone = BUCKET_TONE[c.bucket] ?? "dim";
    // meeting-outcome-due rides the owe bucket but owes bookkeeping, not a
    // reply — say so (same phrase family as core/codebook.py)
    const stateText = c.state === "meeting-outcome-due"
      ? "meeting happened — outcome not logged yet"
      : (BUCKET_TEXT[c.bucket] ?? c.bucket);
    let label = cap(c.key.split(".")[0]);
    const artifacts: GNode[] = [];

    // 1. the humanized company page
    const pageRel = `${c.key}.md`;
    const pageAbs = path.join(VAULT, "companies", pageRel);
    if (fs.existsSync(pageAbs)) {
      let text = "";
      try { text = fs.readFileSync(pageAbs, "utf8"); } catch { /* skip */ }
      pageText.set(c.key, text);
      const h = text.match(/^# (.+?) \(/m); // "# Acme Labs (acme-labs.example.com)" → Acme Labs
      if (h) label = h[1];
      artifacts.push({
        id: `${c.key}:page`, label: "Company page", kind: "file", tone, ftype: "page",
        parent: c.key, root: "companies", relPath: pageRel, tip: `Company page — ${label}`,
      });
    }

    // 2. meeting notes
    const met = meetingFiles.filter((m) => meetingMatches(m.name, c.key)).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_PER_KIND);
    for (const m of met) {
      const state = m.rel.split("/")[0];
      artifacts.push({
        id: `${c.key}:meet:${m.rel}`, label: `Meeting (${state})`, kind: "file", tone, ftype: "meeting",
        parent: c.key, root: "meetings", relPath: m.rel, tip: `Meeting note — ${state} · ${fmtDate(m.mtime)}`,
      });
    }

    // 3. draft packs that wrote to this company
    const packs = (packHits.get(c.key) ?? []).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_PER_KIND);
    for (const p of packs) {
      artifacts.push({
        id: `${c.key}:draft:${p.rel}`, label: `Draft pack${p.date ? ` ${p.date}` : ""}`, kind: "file", tone, ftype: "draft",
        parent: c.key, root: "drafts", relPath: p.rel, tip: `Draft pack — ${p.date || fmtDate(p.mtime)}`,
      });
    }

    // 4. the archivist verdict ("what's happening" summary)
    const verdictRel = `${c.key}.json`;
    if (fs.existsSync(path.join(VAULT, "inbox/intel/verdicts2", verdictRel))) {
      artifacts.push({
        id: `${c.key}:verdict`, label: "What's happening", kind: "file", tone, ftype: "verdict",
        parent: c.key, root: "verdicts", relPath: verdictRel, tip: `"What's happening" summary — ${label}`,
      });
    }

    nodes.push({
      id: c.key, label, kind: "company", tone, bucket: c.bucket, stateText,
      root: pageText.has(c.key) ? "companies" : undefined,
      relPath: pageText.has(c.key) ? pageRel : undefined,
      fileCount: artifacts.length,
      tip: `${label} — ${stateText} · ${artifacts.length} file${artifacts.length === 1 ? "" : "s"}`,
    });
    for (const a of artifacts) {
      nodes.push(a);
      links.push({ source: c.key, target: a.id, kind: "owns" });
      fileNodes++;
    }
  }

  // company → company edges from [[wikilinks]] in company pages
  const seen = new Set<string>();
  for (const [key, text] of pageText) {
    let m: RegExpExecArray | null;
    WIKILINK.lastIndex = 0;
    while ((m = WIKILINK.exec(text))) {
      const tgt = m[1].trim().toLowerCase().replace(/\.md$/, "");
      if (tgt !== key && keySet.has(tgt)) {
        const edge = key < tgt ? `${key}|${tgt}` : `${tgt}|${key}`;
        if (!seen.has(edge)) { seen.add(edge); links.push({ source: key, target: tgt, kind: "link" }); }
      }
    }
  }

  return Response.json({
    ranAt: Date.now(),
    mode: "company-rooted",
    stats: { companies: companies.length, files: fileNodes, crossLinks: seen.size },
    nodes,
    links,
  });
}

// ──────────────────── mode=map (DEFAULT — the Russian dolls) ────────────────────
// The condensed structural map the operator specified: Agent → its KEY FILES →
// named area clusters (with counts) → sub-clusters. No file dumps — folders
// nest like Russian dolls; clicking a cluster opens that folder in the Files
// tab (navigation lives THERE, not here). Dashed edges = markdown files in one
// area referencing files in another (the horizontal information flow).

// vault-relative area → Files-tab drive + dir inside it (for click-through)
const AREA_TO_ROOT: [string, string][] = [
  ["inbox/intel/verdicts2", "verdicts"],
  ["inbox/intel", "intel"],
  ["pipeline/drafts", "drafts"],
  ["pipeline/sent", "sent"],
  ["pipeline/outbox", "outbox"],
  ["pipeline/cadence", "cadence"],
  ["companies", "companies"],
  ["meetings", "meetings"],
  ["audits", "audits"],
  ["reference", "reference"],
  ["leads", "leads"],
  ["rfps", "rfps"],
  ["state", "state"],
  ["os", "os"],
  ["clients", "clients"],
  ["suppression", "suppression"],
  ["metrics", "metrics"],
  ["plans", "plans"],
  ["service", "service"],
];
function areaTarget(rel: string): { root: string; dir: string } | null {
  for (const [prefix, root] of AREA_TO_ROOT) {
    if (rel === prefix || rel.startsWith(prefix + "/")) {
      return { root, dir: rel === prefix ? "" : rel.slice(prefix.length + 1) };
    }
  }
  return null;
}

// plain-language names for the top-level areas
const AREA_LABEL: Record<string, string> = {
  "state": "Board & state",
  "os": "System",
  "companies": "Company pages",
  "meetings": "Meetings",
  "inbox/intel": "Inbox intelligence",
  "pipeline/drafts": "Draft packs",
  "pipeline/sent": "Sent records",
  "pipeline/outbox": "Outbox",
  "pipeline/cadence": "Cadence",
  "audits": "Audits",
  "reference": "Reference",
  "leads": "Leads",
  "rfps": "RFPs",
  "clients": "Clients (legacy)",
  "suppression": "Do-not-send lists",
  "metrics": "Metrics",
  "plans": "Plans",
  "service": "Service",
};
const prettySeg = (s: string) => {
  const t = s.replace(/^_+/, "").replace(/[-_]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : s;
};
const MAX_SUBS = 8; // sub-folders shown per area; the rest condense into one node

async function mapGraph() {
  const manifest = loadOwnership();
  const roster = manifest.agents.map((m) => {
    const id = m.agent.toLowerCase();
    const vis = AGENTS.find((x) => x.id === id);
    return {
      id,
      name: m.agent,
      paths: m.paths,
      role: vis?.role ?? EXTRA_IDENTITY[id]?.role ?? "",
      color: vis?.color ?? EXTRA_IDENTITY[id]?.color ?? DEFAULT_AGENT_COLOR,
      central: id === "valence",
    };
  });
  const valence = roster.find((r) => r.central) ?? roster[0];
  if (!valence) return NextResponse.json({ error: "ownership manifest unreadable (vault/os/ownership.md)" }, { status: 502 });

  type Node = {
    id: string; label: string; kind: "agent" | "key" | "area" | "sub";
    color: string; central?: boolean; parent?: string; count?: number;
    root?: string; dir?: string; tip: string;
  };
  type Link = { source: string; target: string; kind: "command" | "key" | "branch" | "ref"; count?: number };

  const nodes: Node[] = [];
  const links: Link[] = [];
  const EXHAUST = new Set(["os/mirror", "inbox/intel/corpus"].map((p) => path.join(VAULT, p)));
  // markdown leaves per area — for the cross-reference (dashed) edges
  const mdByArea: { area: string; name: string; full: string }[] = [];
  const slugToArea = new Map<string, string>();
  let totalFiles = 0;

  for (const a of roster) {
    // ── tier 1: the agent ──
    // ── tier 2: KEY FILES (the agent's definition — AGENT/CONTEXT/HEARTBEAT/
    //    processes/tools/skills). Still read from VenusV2 staging until the
    //    approved reorg moves them into the vault (Build 8, main session). ──
    const keyFiles = await walk(path.join(V2, "os/agents", a.id));
    keyFiles.forEach((f, i) => {
      const kid = `${a.id}:key:${i}`;
      nodes.push({
        id: kid, label: pretty(f.name), kind: "key", color: a.color, parent: a.id,
        tip: `Key file — ${f.name} · defines ${a.name} (moves into the vault at the reorg)`,
      });
      links.push({ source: a.id, target: kid, kind: "key" });
    });

    // ── tier 3: owned areas as condensed clusters ──
    let agentFiles = 0;
    for (const rel of a.paths) {
      const abs = path.join(VAULT, rel);
      const leaves = await walk(abs, 0, [], EXHAUST);
      agentFiles += leaves.length;
      const areaId = `area:${rel}`;
      const label = AREA_LABEL[rel] ?? prettySeg(rel.split("/").pop()!);
      const tgt = areaTarget(rel);
      nodes.push({
        id: areaId, label, kind: "area", color: a.color, parent: a.id, count: leaves.length,
        root: tgt?.root, dir: tgt?.dir,
        tip: `${label} — ${leaves.length} file${leaves.length === 1 ? "" : "s"} · owned by ${a.name} · click to browse in Files`,
      });
      links.push({ source: a.id, target: areaId, kind: "branch" });

      // register markdown leaves for reference edges
      for (const f of leaves) {
        if (f.name.endsWith(".md")) {
          mdByArea.push({ area: areaId, name: f.name, full: f.full });
          slugToArea.set(norm(f.name), areaId);
        }
      }

      // ── tier 4: immediate sub-folders (one doll deeper), biggest first ──
      const subDirs: { name: string; count: number }[] = [];
      try {
        const dirents = await fsp.readdir(abs, { withFileTypes: true });
        for (const d of dirents) {
          if (!d.isDirectory() || d.name.startsWith(".")) continue;
          if (EXHAUST.has(path.join(abs, d.name))) continue;
          const c = (await walk(path.join(abs, d.name), 1, [], EXHAUST)).length;
          subDirs.push({ name: d.name, count: c });
        }
      } catch { /* flat area */ }
      subDirs.sort((x, y) => y.count - x.count);
      const shown = subDirs.slice(0, MAX_SUBS);
      const rest = subDirs.slice(MAX_SUBS);
      for (const s of shown) {
        const subId = `${areaId}/${s.name}`;
        const st = areaTarget(`${rel}/${s.name}`);
        nodes.push({
          id: subId, label: prettySeg(s.name), kind: "sub", color: a.color, parent: areaId, count: s.count,
          root: st?.root, dir: st?.dir,
          tip: `${prettySeg(s.name)} — ${s.count} file${s.count === 1 ? "" : "s"} inside ${label} · click to browse`,
        });
        links.push({ source: areaId, target: subId, kind: "branch" });
      }
      if (rest.length) {
        const moreId = `${areaId}:more`;
        const moreCount = rest.reduce((s, x) => s + x.count, 0);
        nodes.push({
          id: moreId, label: `${rest.length} more folders`, kind: "sub", color: a.color, parent: areaId, count: moreCount,
          root: tgt?.root, dir: tgt?.dir,
          tip: `${rest.length} more folders (${moreCount} files) — click to browse all of ${label}`,
        });
        links.push({ source: areaId, target: moreId, kind: "branch" });
      }
    }
    totalFiles += agentFiles;
    nodes.push({
      id: a.id, label: a.name, kind: "agent", color: a.color, central: a.central, count: agentFiles,
      tip: `${a.name} — ${a.role || "agent"} · ${agentFiles.toLocaleString("en-US")} files in its care`,
    });
    if (!a.central) links.push({ source: valence.id, target: a.id, kind: "command" });
  }

  // ── dashed reference edges: markdown in one area pointing into another ──
  const MDLINK = /\[[^\]]*\]\(([^)\s]+\.md)\)/g;
  const refCounts = new Map<string, number>();
  const SCAN_CAP = 400;
  await Promise.all(mdByArea.slice(0, SCAN_CAP).map(async ({ area, full }) => {
    let text = "";
    try { text = await fsp.readFile(full, "utf8"); } catch { return; }
    const targets: string[] = [];
    let m: RegExpExecArray | null;
    WIKILINK.lastIndex = 0;
    while ((m = WIKILINK.exec(text))) targets.push(m[1]);
    MDLINK.lastIndex = 0;
    while ((m = MDLINK.exec(text))) targets.push(m[1].split("/").pop()!);
    for (const t of targets) {
      const other = slugToArea.get(norm(t));
      if (other && other !== area) {
        const key = area < other ? `${area}|${other}` : `${other}|${area}`;
        refCounts.set(key, (refCounts.get(key) ?? 0) + 1);
      }
    }
  }));
  for (const [key, count] of refCounts) {
    const [s, t] = key.split("|");
    links.push({ source: s, target: t, kind: "ref", count });
  }

  // ── the alarm gauge: files nobody owns (top-level dirs outside the manifest) ──
  const owned = new Set(roster.flatMap((r) => r.paths.map((p) => p.split("/")[0])));
  let unownedFiles = 0;
  const unownedAreas: string[] = [];
  try {
    for (const d of await fsp.readdir(VAULT, { withFileTypes: true })) {
      if (d.name.startsWith(".")) continue;
      if (d.isDirectory()) {
        if (owned.has(d.name)) continue;
        const c = (await walk(path.join(VAULT, d.name))).length;
        if (c > 0) { unownedFiles += c; unownedAreas.push(`${d.name} (${c})`); }
      }
    }
  } catch { /* */ }

  return NextResponse.json({
    ranAt: Date.now(),
    mode: "map",
    stats: {
      agents: roster.length,
      areas: nodes.filter((n) => n.kind === "area").length,
      files: totalFiles,
      refs: refCounts.size,
      unownedFiles,
      unownedAreas,
    },
    nodes,
    links,
  });
}

// ──────────────── mode=vault (EVERY folder & file — the 3D map) ────────────────
// The full vault as one object: agents (from the ownership manifest) → their
// owned area folders → every sub-folder → every file. Node color = the owning
// agent's identity color. "ref" edges = one markdown file pointing at another
// ([[wikilink]] or relative .md link) — the horizontal information flow, now at
// FILE level. Click-through targets reuse the Files-drive mapping so any node
// can open in the navigator below the graph. Payload is cached and rebuilt only
// when the vault actually changes (file count / newest mtime fingerprint).

// tier = the node's locked level in the chandelier layout (operator design
// 2026-07-12): 0 Valence · 1 agents · 2 key agent files · 3 area folders ·
// deeper folders/files step down from there. The client pins each node's
// height to its tier; physics only arranges nodes WITHIN a level.
interface VNode {
  id: string; label: string; kind: "agent" | "key" | "dir" | "file";
  tier: number;
  color: string; central?: boolean; count?: number; bytes?: number;
  owner?: string; root?: string; dir?: string; path?: string; tip: string;
}
interface VLink { source: string; target: string; kind: "command" | "key" | "branch" | "ref" | "orphan" }

// same noise rules as the Files drives — the graph and the navigator agree
function vaultNoise(name: string, isDir: boolean): boolean {
  if (name.startsWith(".")) return true;
  if (isDir) return name === "__pycache__" || name === "node_modules";
  if (name.endsWith(".pyc") || name.endsWith(".tmp")) return true;
  if (name.includes(".bak")) return true;
  if (name.endsWith(".threaded.json")) return true;
  return false;
}

let vaultCache: { fp: string; body: unknown } | null = null;

async function vaultGraph() {
  const manifest = loadOwnership();
  const roster = manifest.agents.map((m) => {
    const id = m.agent.toLowerCase();
    const vis = AGENTS.find((x) => x.id === id);
    return {
      id,
      name: m.agent,
      paths: m.paths,
      role: vis?.role ?? EXTRA_IDENTITY[id]?.role ?? "",
      color: vis?.color ?? EXTRA_IDENTITY[id]?.color ?? DEFAULT_AGENT_COLOR,
      central: id === "valence",
    };
  });
  const valence = roster.find((r) => r.central) ?? roster[0];
  if (!valence) return NextResponse.json({ error: "ownership manifest unreadable (vault/os/ownership.md)" }, { status: 502 });

  const EXHAUST = new Set(["os/mirror", "inbox/intel/corpus"]);
  const ownedPaths = new Set(roster.flatMap((r) => r.paths));

  interface Dir { rel: string; count: number }
  interface Fil { rel: string; name: string; bytes: number; mtime: number }

  // full walk of one owned area — returns file count; skips noise, machine
  // exhaust, and any nested dir that is ITSELF another agent's owned area
  // (that subtree renders once, under its own agent).
  async function walkAll(rel: string, dirs: Dir[], files: Fil[], depth = 0): Promise<number> {
    if (depth > 12) return 0;
    let entries;
    try { entries = await fsp.readdir(path.join(VAULT, rel), { withFileTypes: true }); } catch { return 0; }
    let count = 0;
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (vaultNoise(e.name, e.isDirectory())) continue;
      if (e.isDirectory()) {
        if (EXHAUST.has(childRel) || ownedPaths.has(childRel)) continue;
        const dir: Dir = { rel: childRel, count: 0 };
        dirs.push(dir);
        dir.count = await walkAll(childRel, dirs, files, depth + 1);
        count += dir.count;
      } else {
        let bytes = 0, mtime = 0;
        try { const st = await fsp.stat(path.join(VAULT, childRel)); bytes = st.size; mtime = st.mtimeMs; } catch { /* raced */ }
        files.push({ rel: childRel, name: e.name, bytes, mtime });
        count++;
      }
    }
    return count;
  }

  // ── gather: owned areas per agent, then the unowned top-level leftovers ──
  const perAgent: { agent: (typeof roster)[number]; area: string; dirs: Dir[]; files: Fil[]; count: number }[] = [];
  for (const a of roster) {
    for (const rel of a.paths) {
      const dirs: Dir[] = [], files: Fil[] = [];
      const count = await walkAll(rel, dirs, files);
      perAgent.push({ agent: a, area: rel, dirs, files, count });
    }
  }
  const ownedTop = new Set(roster.flatMap((r) => r.paths.map((p) => p.split("/")[0])));
  const unownedAreas: { rel: string; dirs: Dir[]; files: Fil[]; count: number }[] = [];
  try {
    for (const d of await fsp.readdir(VAULT, { withFileTypes: true })) {
      if (!d.isDirectory() || vaultNoise(d.name, true) || ownedTop.has(d.name)) continue;
      const dirs: Dir[] = [], files: Fil[] = [];
      const count = await walkAll(d.name, dirs, files);
      if (count > 0) unownedAreas.push({ rel: d.name, dirs, files, count });
    }
  } catch { /* vault unreadable — stats stay zero */ }

  // key agent files (the definition tier) — walked up front so the cache
  // fingerprint sees them too
  const keyByAgent = new Map<string, Leaf[]>();
  for (const a of roster) keyByAgent.set(a.id, await walk(path.join(V2, "os/agents", a.id)));
  const keyLeaves = [...keyByAgent.values()].flat();

  // fingerprint — rebuild the (markdown-scan-heavy) payload only on real change
  const allFiles = [...perAgent.flatMap((p) => p.files), ...unownedAreas.flatMap((u) => u.files)];
  let maxM = 0;
  for (const f of allFiles) if (f.mtime > maxM) maxM = f.mtime;
  for (const f of keyLeaves) if (f.mtime > maxM) maxM = f.mtime;
  const fp = `${allFiles.length}:${keyLeaves.length}:${maxM}:${manifest.asOf}`;
  if (vaultCache && vaultCache.fp === fp) return NextResponse.json(vaultCache.body);

  const nodes: VNode[] = [];
  const links: VLink[] = [];
  const slugToFile = new Map<string, string>();
  const dirId = (rel: string) => `d:${rel}`;
  const fileId = (rel: string) => `f:${rel}`;

  const fileLabel = (name: string) => name.replace(/\.md$/i, "");

  function addTree(
    ownerName: string | null, color: string, anchor: string,
    areaRel: string, dirs: Dir[], files: Fil[],
  ) {
    const ownedBy = ownerName ? ` · looked after by ${ownerName}` : " · nobody looks after this yet";
    // area root dir node — hangs off its anchor (the agent, or the unowned hub)
    // tier bookkeeping: area roots sit on level 3; every folder level steps
    // one down; a file hangs one level under its folder
    const AREA_TIER = 3;
    const depthOf = (rel: string) => rel.split("/").length - areaRel.split("/").length;

    const rootTgt = areaTarget(areaRel);
    const areaFiles = files.length;
    nodes.push({
      id: dirId(areaRel), label: AREA_LABEL[areaRel] ?? prettySeg(areaRel.split("/").pop()!), kind: "dir",
      tier: AREA_TIER,
      color, count: areaFiles, owner: ownerName ?? undefined,
      root: rootTgt?.root, dir: rootTgt?.dir,
      tip: `${AREA_LABEL[areaRel] ?? prettySeg(areaRel.split("/").pop()!)} — ${areaFiles} file${areaFiles === 1 ? "" : "s"}${ownedBy}${rootTgt ? " · click to browse below" : ""}`,
    });
    links.push({ source: anchor, target: dirId(areaRel), kind: anchor === "unowned" ? "orphan" : "branch" });

    for (const d of dirs) {
      const tgt = areaTarget(d.rel);
      nodes.push({
        id: dirId(d.rel), label: prettySeg(d.rel.split("/").pop()!), kind: "dir",
        tier: AREA_TIER + depthOf(d.rel),
        color, count: d.count, owner: ownerName ?? undefined,
        root: tgt?.root, dir: tgt?.dir,
        tip: `${prettySeg(d.rel.split("/").pop()!)} — ${d.count} file${d.count === 1 ? "" : "s"}${ownedBy}${tgt ? " · click to browse below" : ""}`,
      });
      const up = d.rel.split("/").slice(0, -1).join("/");
      links.push({ source: up === areaRel || up.startsWith(areaRel + "/") ? dirId(up) : dirId(areaRel), target: dirId(d.rel), kind: "branch" });
    }
    for (const f of files) {
      // areaTarget maps the vault-relative path to a Files drive + in-drive path
      const tgt = areaTarget(f.rel);
      const up = f.rel.split("/").slice(0, -1).join("/");
      nodes.push({
        id: fileId(f.rel), label: fileLabel(f.name), kind: "file",
        tier: AREA_TIER + depthOf(up) + 1,
        color, bytes: f.bytes, owner: ownerName ?? undefined,
        root: tgt?.root, path: tgt?.dir,
        tip: `${f.name}${ownedBy}${tgt ? " · click to read below" : ""}`,
      });
      links.push({ source: up === areaRel || up.startsWith(areaRel + "/") ? dirId(up) : dirId(areaRel), target: fileId(f.rel), kind: "branch" });
      if (f.name.endsWith(".md")) slugToFile.set(norm(f.name), fileId(f.rel));
    }
  }

  // agents first (their file nodes reference them as anchors), each with its
  // KEY FILES — the agent's definition (AGENT/CONTEXT/HEARTBEAT/processes),
  // still read from VenusV2 staging until the approved reorg moves them into
  // the vault (operator ruling 2026-07-12: show the true current structure)
  let keyFileCount = 0;
  for (const a of roster) {
    const count = perAgent.filter((p) => p.agent.id === a.id).reduce((s, p) => s + p.count, 0);
    nodes.push({
      id: a.id, label: a.name, kind: "agent", tier: a.central ? 0 : 1, color: a.color, central: a.central, count,
      tip: `${a.name} — ${a.role || "agent"} · ${count.toLocaleString("en-US")} file${count === 1 ? "" : "s"} in its care`,
    });
    if (!a.central) links.push({ source: valence.id, target: a.id, kind: "command" });
    const keyFiles = keyByAgent.get(a.id) ?? [];
    keyFiles.forEach((f, i) => {
      const kid = `${a.id}:key:${i}`;
      keyFileCount++;
      nodes.push({
        id: kid, label: pretty(f.name), kind: "key", tier: 2, color: a.color,
        tip: `Key file — ${f.name} · defines ${a.name} (moves into the vault at the reorg)`,
      });
      links.push({ source: a.id, target: kid, kind: "key" });
    });
  }
  for (const p of perAgent) addTree(p.agent.name, p.agent.color, p.agent.id, p.area, p.dirs, p.files);

  let unownedFiles = 0;
  if (unownedAreas.length) {
    unownedFiles = unownedAreas.reduce((s, u) => s + u.count, 0);
    nodes.push({
      id: "unowned", label: "No owner yet", kind: "agent", tier: 1, color: DEFAULT_AGENT_COLOR, count: unownedFiles,
      tip: `Nobody looks after these ${unownedFiles.toLocaleString("en-US")} files yet — assign them in the ownership manifest`,
    });
    links.push({ source: valence.id, target: "unowned", kind: "orphan" });
    for (const u of unownedAreas) addTree(null, DEFAULT_AGENT_COLOR, "unowned", u.rel, u.dirs, u.files);
  }

  // ── file-to-file reference edges from every markdown note ──
  const MDLINK2 = /\[[^\]]*\]\(([^)\s]+\.md)\)/g;
  const mdFiles = allFiles.filter((f) => f.name.endsWith(".md") && f.bytes < 2 * 1024 * 1024);
  const refSeen = new Set<string>();
  await Promise.all(mdFiles.map(async (f) => {
    const src = fileId(f.rel);
    let text = "";
    try { text = await fsp.readFile(path.join(VAULT, f.rel), "utf8"); } catch { return; }
    const targets: string[] = [];
    let m: RegExpExecArray | null;
    WIKILINK.lastIndex = 0;
    while ((m = WIKILINK.exec(text))) targets.push(m[1]);
    MDLINK2.lastIndex = 0;
    while ((m = MDLINK2.exec(text))) targets.push(m[1].split("/").pop()!);
    for (const t of targets) {
      const tgt = slugToFile.get(norm(t));
      if (tgt && tgt !== src) {
        const key = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
        if (!refSeen.has(key)) { refSeen.add(key); links.push({ source: src, target: tgt, kind: "ref" }); }
      }
    }
  }));

  const body = {
    ranAt: Date.now(),
    mode: "vault",
    stats: {
      agents: roster.length,
      keyFiles: keyFileCount,
      folders: nodes.filter((n) => n.kind === "dir").length,
      files: allFiles.length,
      refs: refSeen.size,
      unownedFiles,
      unownedAreas: unownedAreas.map((u) => `${u.rel} (${u.count})`),
    },
    nodes,
    links,
  };
  vaultCache = { fp, body };
  return NextResponse.json(body);
}

// ────────────────────────────────── dispatch ──────────────────────────────────

export async function GET(req: Request) {
  const mode = new URL(req.url).searchParams.get("mode") ?? "map";
  if (mode === "companies") return companyGraph();
  if (mode === "agents") return agentGraph();
  if (mode === "vault") return vaultGraph();
  return mapGraph();
}
