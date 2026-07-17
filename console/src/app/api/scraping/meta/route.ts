import fs from "node:fs";
import path from "node:path";
import { VAULT, run } from "@/lib/vault";
import { fixture, fixturesOn } from "@/lib/fixtures";
import { COUNTRIES, canonicalCategory, canonicalCountry, categoryWord } from "@/lib/leadLabels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Scraping tab metadata — pool level, category keys, mined history (with
// already-emailed counts), suggested veins, and the source scoreboard.
// Read-only; the run lifecycle lives in ../run.

const SCRAPLING_PY = "/opt/scrapling-venv/bin/python3";
const LG_TOOLS = `${process.env.HOME || ""}/.claude/skills/leadgen/tools`;
const VERIFIED_DIR = path.join(VAULT, "leads/verified");
const LEDGER = path.join(VAULT, "pipeline/cadence/ledger.json");
const TUNNEL_LEDGER = path.join(VAULT, "leads/discovery-paths.jsonl");

// Category picker options — the discovery tool emits BOTH the machine key and
// the human label; the operator only ever sees the label (COUNTRIES + the slug
// repair layer live in lib/leadLabels — one vocabulary module for all surfaces).
interface Category { key: string; label: string }
let categoriesCache: Category[] | null = null;
async function categories(): Promise<Category[]> {
  if (categoriesCache) return categoriesCache;
  const r = await run(SCRAPLING_PY, [path.join(LG_TOOLS, "source_discovery.py"), "--list-categories"], { cwd: LG_TOOLS, timeout: 30_000 });
  // tool emits JSON: {"categories": [{"key": "...", "label": "...", ...}, ...]}
  let cats: Category[] = [];
  try {
    const parsed = JSON.parse(r.stdout) as { categories?: { key?: string; label?: string }[] };
    cats = (parsed.categories ?? [])
      .filter((c) => /^[a-z0-9-]{3,}$/.test(c.key ?? ""))
      .map((c) => ({ key: c.key!, label: c.label?.trim() || categoryWord(c.key) }));
  } catch { /* tool unavailable — picker stays empty, dig can't start */ }
  if (cats.length > 0) categoriesCache = cats;
  return cats;
}

interface VBatch { batch_id?: string; client_type?: string; geo?: string; date?: string; leads?: { email?: string }[] }

function contactedEmails(): Set<string> {
  const s = new Set<string>();
  try {
    const led = JSON.parse(fs.readFileSync(LEDGER, "utf8")) as { leads?: { email?: string }[] };
    for (const l of led.leads ?? []) if (l.email) s.add(l.email.toLowerCase());
  } catch { /* ledger optional */ }
  return s;
}

function history(contacted: Set<string>) {
  const out: { file: string; batch: string; category: string; geo: string; date: string; landed: number; emailed: number }[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(VERIFIED_DIR).filter((n) => n.endsWith(".json")); } catch { return out; }
  for (const n of names) {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(VERIFIED_DIR, n), "utf8")) as VBatch;
      // emailed = addresses from this batch that the send ledger has seen — the
      // "did we use what we mined" number (same ledger the fresh-pool join uses)
      let emailed = 0;
      for (const l of b.leads ?? []) if (l.email && contacted.has(l.email.toLowerCase())) emailed++;
      out.push({
        file: n,
        batch: b.batch_id ?? n.replace(/\.json$/, ""),
        category: b.client_type ?? "—",
        geo: b.geo ?? "—",
        date: b.date ?? (n.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "—"),
        landed: (b.leads ?? []).length,
        emailed,
      });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => (b.date > a.date ? 1 : -1));
  return out; // all-time (operator decision 2026-07-10)
}

// Source scoreboard — states come from the discovery tool itself (parity: the
// console never re-derives FRESH/PRODUCTIVE/TAPPED-OUT). Cached per tunnel-
// ledger mtime; the ledger only changes when a dig records a run.
interface Tunnel { status: string; total_kept: number; last_kept: number; last_run: string; country: string; name: string; url: string; icp_pct: string }
let tunnelCache: { mtime: number; rows: Tunnel[] } | null = null;
async function sources(): Promise<Tunnel[]> {
  let mtime = 0;
  try { mtime = fs.statSync(TUNNEL_LEDGER).mtimeMs; } catch { /* no ledger yet — still list seeds */ }
  if (tunnelCache && tunnelCache.mtime === mtime) return tunnelCache.rows;
  const r = await run(SCRAPLING_PY, [path.join(LG_TOOLS, "curated_discovery.py"), "--report", "--json"], { cwd: LG_TOOLS, timeout: 30_000 });
  try {
    const rows = (JSON.parse(r.stdout) as { tunnels?: Tunnel[] }).tunnels ?? [];
    tunnelCache = { mtime, rows };
    return rows;
  } catch { return tunnelCache?.rows ?? []; }
}

function poolLevel(contacted: Set<string>): { verified: number; uncontacted: number } {
  let verified = 0, uncontacted = 0;
  try {
    for (const n of fs.readdirSync(VERIFIED_DIR).filter((x) => x.endsWith(".json"))) {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(VERIFIED_DIR, n), "utf8")) as VBatch;
        for (const l of b.leads ?? []) {
          if (!l.email) continue;
          verified++;
          if (!contacted.has(l.email.toLowerCase())) uncontacted++;
        }
      } catch { /* skip */ }
    }
  } catch { /* no dir */ }
  return { verified, uncontacted };
}

// Suggested repeats = proven (category, geo) pairs, best past yield first,
// oldest last-mined breaking ties — SUGGESTIONS ONLY (the operator picks the
// dig; nothing here auto-starts anything). Every pair is resolved to CANONICAL
// picker values before it ships: a suggestion that can't actually fill the
// form is a dead control (doctrine tenet 13), so unresolvable pairs are
// dropped here, server-side, not papered over in the view.
function veins(hist: ReturnType<typeof history>, liveKeys: string[]) {
  const agg = new Map<string, { category: string; country: string; landed: number; lastMined: string; runs: number }>();
  for (const h of hist) {
    const category = canonicalCategory(h.category, liveKeys);
    const country = canonicalCountry(h.geo);
    if (!category || !country) continue;
    const k = `${category}|${country}`;
    const v = agg.get(k) ?? { category, country, landed: 0, lastMined: "0000", runs: 0 };
    v.landed += h.landed; v.runs++;
    if (h.date > v.lastMined) v.lastMined = h.date;
    agg.set(k, v);
  }
  return [...agg.values()]
    .sort((a, b) => (b.landed - a.landed) || (a.lastMined > b.lastMined ? 1 : -1))
    .slice(0, 8);
}

export async function GET() {
  if (fixturesOn()) return Response.json(fixture("scraping-meta") ?? { categories: [], countries: [], pool: { verified: 0, uncontacted: 0 }, veins: [], history: [], sources: [] });
  const contacted = contactedEmails();
  const hist = history(contacted);
  const cats = await categories();
  return Response.json({
    categories: cats,
    countries: COUNTRIES,
    pool: poolLevel(contacted),
    veins: veins(hist, cats.map((c) => c.key)),
    history: hist,
    sources: await sources(),
  });
}
