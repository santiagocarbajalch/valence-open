import fs from "node:fs";
import path from "node:path";
import { startJob, jobStatus } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Scraping tab's run lifecycle — a clickable UI over the PROVEN /leadgen
// funnel (~/.claude/skills/leadgen). Same stages, same tools, same operator
// checkpoints; one run at a time. Manual only: every stage advance is a click.
//
//   start    → Stage 1 DISCOVER (source_discovery.py)
//   review_discover  —operator approves candidates→
//   qualify  → Stage 1.5 buying-power evidence (enrich_size.py)
//   review_qualify   —operator approves survivors→
//   scrape   → Stage 2 (scrape_orchestrator.py, 3-tier)
//   review_scrape    —operator approves raw haul (+ optional --llm on ICP)→
//   icp      → Stage 3 (icp_classify.py)   [auto-chains]
//   verify   → Stage 4 (process_leads_batch.py — Reacher preflight inside)
//   done     → funnel report; leads landed in vault/leads/verified/
//
// State is DURABLE (workspace/runs/scraping/current.json) — a browser refresh
// never loses a dig mid-checkpoint.

const SCRAPLING_PY = "/opt/scrapling-venv/bin/python3";
const SYS_PY = "/usr/bin/python3";
const LG = `${process.env.HOME || ""}/.claude/skills/leadgen/tools`;
const RUNS = "/opt/velab/workspace/runs/scraping";
const STATE = path.join(RUNS, "current.json");
const RAW_DIR = "/opt/velab/vault/leads/raw";

// operator geo doctrine: ONLY Mexico + India are off-limits
const BANNED_GEO = /mexico|méxico|\bindia\b/i;

interface Candidate { url?: string; title?: string; snippet?: string; domain?: string; [k: string]: unknown }
interface RunState {
  slug: string; category: string; country: string; count: number;
  phase: "discover" | "review_discover" | "qualify" | "review_qualify" | "scrape" | "review_scrape" | "icp" | "verify" | "done" | "error" | "cancelled";
  jobId?: string | null;
  candidates?: Candidate[];   // discover output
  cards?: Candidate[];        // qualify evidence cards
  rawSummary?: { leads: number; withEmail: number; roleInboxes: number; urls: number } | null;
  report?: string | null;     // verify stdout tail (the honest funnel report)
  error?: string | null;
  startedAt: string; updatedAt: string;
}

function read(): RunState | null {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")) as RunState; } catch { return null; }
}
function write(s: RunState) {
  fs.mkdirSync(RUNS, { recursive: true });
  s.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}
function dir(slug: string) { const d = path.join(RUNS, slug); fs.mkdirSync(d, { recursive: true }); return d; }

// tolerant: find the first JSON array in a tool's stdout
function jsonArray(out: string): Candidate[] | null {
  const i = out.indexOf("[");
  if (i < 0) return null;
  for (let end = out.lastIndexOf("]"); end > i; end = out.lastIndexOf("]", end - 1)) {
    try { const v = JSON.parse(out.slice(i, end + 1)); if (Array.isArray(v)) return v as Candidate[]; } catch { /* keep shrinking */ }
  }
  return null;
}

function rawBatchPath(slug: string): string {
  // orchestrator writes batch-<date>-<slug>.json — match on the slug
  try {
    const hit = fs.readdirSync(RAW_DIR).filter((n) => n.includes(slug) && n.endsWith(".json")).sort().pop();
    if (hit) return path.join(RAW_DIR, hit);
  } catch { /* fall through */ }
  return path.join(RAW_DIR, `batch-${slug}.json`);
}

function summarizeRaw(p: string): RunState["rawSummary"] {
  try {
    const b = JSON.parse(fs.readFileSync(p, "utf8")) as { leads?: { email?: string; title?: string; found_on_url?: string }[] };
    const leads = b.leads ?? [];
    return {
      leads: leads.length,
      withEmail: leads.filter((l) => l.email).length,
      roleInboxes: leads.filter((l) => /^(ventas|comercial|compras|gerencia|info|contacto|coordinacion|distribuidores)@/i.test(l.email ?? "")).length,
      urls: new Set(leads.map((l) => l.found_on_url).filter(Boolean)).size,
    };
  } catch { return null; }
}

// jobStatus tails output at 16k — a big discovery JSON would truncate and fail
// to parse. Read the job's full stdout file for parsing.
function fullOut(jobId: string): string {
  try { return fs.readFileSync(path.join("/opt/velab/workspace/runs/console-jobs", `${jobId}.out`), "utf8"); } catch { return ""; }
}

// advance a running stage when its job finished — called lazily from GET
function advance(s: RunState): RunState {
  if (!s.jobId) return s;
  const j = jobStatus(s.jobId);
  if (!j || j.running) return s;
  const out = fullOut(s.jobId) || j.out || "", err = j.err ?? "";
  if (s.phase === "discover") {
    if (j.code !== 0) { s.phase = "error"; s.error = (err || out).slice(-500); }
    else {
      const cands = jsonArray(out);
      if (!cands || cands.length === 0) { s.phase = "error"; s.error = "Discovery returned no candidates — this vein may be exhausted. Try another category/country."; }
      else { s.candidates = cands.slice(0, 80); s.phase = "review_discover"; }
    }
    s.jobId = null;
  } else if (s.phase === "qualify") {
    if (j.code !== 0) { s.phase = "error"; s.error = (err || out).slice(-500); }
    else { s.cards = jsonArray(out) ?? s.candidates ?? []; s.phase = "review_qualify"; }
    s.jobId = null;
  } else if (s.phase === "scrape") {
    if (j.code !== 0) { s.phase = "error"; s.error = (err || out).slice(-500); }
    else { s.rawSummary = summarizeRaw(rawBatchPath(s.slug)); s.phase = "review_scrape"; }
    s.jobId = null;
  } else if (s.phase === "icp") {
    if (j.code !== 0) { s.phase = "error"; s.error = (err || out).slice(-500); s.jobId = null; }
    else {
      // Stage 3 → 4 auto-chain (the skill's checkpoint sits BEFORE icp; verify
      // has its own hard preflight and aborts loudly if Reacher is down)
      s.jobId = startJob({ label: "scraping-verify", argv: [SYS_PY, path.join(LG, "process_leads_batch.py"), rawBatchPath(s.slug), "--pretty"], cwd: LG });
      s.phase = "verify";
    }
  } else if (s.phase === "verify") {
    if (j.code !== 0) { s.phase = "error"; s.error = (err || out).slice(-500); }
    else { s.report = out.slice(-3000); s.phase = "done"; }
    s.jobId = null;
  }
  write(s);
  return s;
}

export async function GET() {
  let s = read();
  if (s && s.jobId) s = advance(s);
  return Response.json({ run: s });
}

interface Body {
  action?: "start" | "continue" | "cancel" | "dismiss";
  category?: string; country?: string; count?: number;
  approved?: number[]; // indices into candidates/cards at the current checkpoint
  llm?: boolean;       // review_scrape → run icp_classify with --llm
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Body;
  let s = read();
  if (s && s.jobId) s = advance(s);

  if (b.action === "start") {
    if (s && !["done", "error", "cancelled"].includes(s.phase)) {
      return Response.json({ error: "A dig is already running — finish or cancel it first (one at a time keeps the box healthy)." }, { status: 409 });
    }
    const category = (b.category ?? "").trim(), country = (b.country ?? "").trim();
    const count = Math.max(1, Math.min(100, b.count ?? 20));
    if (!category || !country) return Response.json({ error: "category and country required" }, { status: 400 });
    if (BANNED_GEO.test(country)) return Response.json({ error: `${country} is off-limits by standing rule — pick another market.` }, { status: 403 });
    const slug = `${new Date().toISOString().slice(0, 10)}-${category}-${country}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");
    dir(slug);
    const jobId = startJob({
      label: "scraping-discover",
      argv: [SCRAPLING_PY, path.join(LG, "source_discovery.py"), "--category", category, "--country", country, "--max", String(count * 2), "--max-queries", "6"],
      cwd: LG,
    });
    const next: RunState = { slug, category, country, count, phase: "discover", jobId, startedAt: new Date().toISOString(), updatedAt: "" };
    write(next);
    return Response.json({ ok: true, run: next });
  }

  if (!s) return Response.json({ error: "no run" }, { status: 400 });

  if (b.action === "cancel") {
    // honest cancel: the in-flight step finishes on its own but nothing further
    // runs and the run slot frees immediately
    s.phase = "cancelled"; s.jobId = null; write(s);
    return Response.json({ ok: true, run: s });
  }

  if (b.action === "dismiss") {
    try { fs.unlinkSync(STATE); } catch { /* gone */ }
    return Response.json({ ok: true, run: null });
  }

  if (b.action === "continue") {
    const approved = Array.isArray(b.approved) ? b.approved : null;
    if (s.phase === "review_discover") {
      const pool = s.candidates ?? [];
      const chosen = (approved ?? pool.map((_, i) => i)).map((i) => pool[i]).filter(Boolean);
      if (chosen.length === 0) return Response.json({ error: "nothing approved" }, { status: 400 });
      fs.writeFileSync(path.join(dir(s.slug), "cand.json"), JSON.stringify(chosen, null, 1));
      s.jobId = startJob({
        label: "scraping-qualify",
        argv: [SCRAPLING_PY, path.join(LG, "enrich_size.py"), "--candidates", path.join(dir(s.slug), "cand.json"), "--country", s.country, "--pretty"],
        cwd: LG,
      });
      s.phase = "qualify"; write(s);
      return Response.json({ ok: true, run: s });
    }
    if (s.phase === "review_qualify") {
      const pool = s.cards ?? s.candidates ?? [];
      const chosen = (approved ?? pool.map((_, i) => i)).map((i) => pool[i]).filter(Boolean);
      const urls = chosen.map((c) => c.url).filter(Boolean) as string[];
      if (urls.length === 0) return Response.json({ error: "nothing approved" }, { status: 400 });
      const urlsFile = path.join(dir(s.slug), "urls.txt");
      fs.writeFileSync(urlsFile, urls.join("\n") + "\n");
      s.jobId = startJob({
        label: "scraping-scrape",
        argv: [SCRAPLING_PY, path.join(LG, "scrape_orchestrator.py"),
          "--urls-file", urlsFile, "--batch-name", s.slug,
          "--category", s.category, "--country", s.country,
          "--target-description", `${s.category} in ${s.country}`,
          "--max-subpaths", "4"],
        cwd: LG,
      });
      s.phase = "scrape"; write(s);
      return Response.json({ ok: true, run: s });
    }
    if (s.phase === "review_scrape") {
      const args = [path.join(LG, "icp_classify.py"), rawBatchPath(s.slug), "--country", s.country];
      if (b.llm) args.push("--llm");
      s.jobId = startJob({ label: "scraping-icp", argv: [SCRAPLING_PY, ...args], cwd: LG });
      s.phase = "icp"; write(s);
      return Response.json({ ok: true, run: s });
    }
    return Response.json({ error: `nothing to continue from ${s.phase}` }, { status: 400 });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
