import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentId } from "@/lib/agents";
import { run, PY } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pexec = promisify(exec);
const VAULT = "/opt/velab/vault";

type Level = "ok" | "warn" | "fail";
interface Check { label: string; level: Level; detail: string; }
interface AgentReport {
  agent: AgentId;
  status: Level;
  summary: string;
  checks: Check[];
  headline: { label: string; value: string }[]; // real numbers to surface
}

async function readJSON(p: string): Promise<unknown | null> {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}
async function countDir(p: string, filterExt?: string): Promise<number> {
  try {
    const ls = await fs.readdir(p);
    return filterExt ? ls.filter((f) => f.endsWith(filterExt)).length : ls.length;
  } catch { return -1; }
}
async function mtimeAgeHours(p: string): Promise<number | null> {
  try { const st = await fs.stat(p); return (Date.now() - st.mtimeMs) / 3.6e6; } catch { return null; }
}

// Health of the SHARDED inbox corpus (vault/inbox/intel/corpus/) — the truth backbone
// /inbox-check reads. Reflects the 2026-06-29 rebuild: date-bounded pulls (corpus-reconcile 4x/day +
// corpus-today on-receipt) and the coverage gate. ageMin = since the last SUCCESSFUL pull; holes =
// unpulled days in [since..today] that would make a board miss/stale a reply.
const CORPUS_SINCE = "2026-05-01";
async function corpusHealth(): Promise<{ ageMin: number | null; lastMode: string; lastStatus: string; holes: number }> {
  const dir = `${VAULT}/inbox/intel/corpus`;
  let ageMin: number | null = null, lastMode = "—", lastStatus = "—";
  try {
    const lines = (await fs.readFile(`${dir}/pulls.jsonl`, "utf8")).trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]) as { mode: string; status: string };
    lastMode = last.mode; lastStatus = last.status;
    for (let i = lines.length - 1; i >= 0; i--) {
      const p = JSON.parse(lines[i]) as { status: string; finished: string };
      if (p.status === "ok" || p.status === "partial") { ageMin = (Date.now() - Date.parse(p.finished)) / 6e4; break; }
    }
  } catch { /* no pull log yet */ }
  let holes = -1;
  try {
    const cov = new Set(JSON.parse(await fs.readFile(`${dir}/covered_dates.json`, "utf8")) as string[]);
    holes = 0;
    const d = new Date(`${CORPUS_SINCE}T00:00:00Z`), today = new Date();
    for (; d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
      if (!cov.has(d.toISOString().slice(0, 10))) holes++;
    }
  } catch { /* coverage registry absent */ }
  return { ageMin, lastMode, lastStatus, holes };
}
const worst = (checks: Check[]): Level =>
  checks.some((c) => c.level === "fail") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "ok";

// ---- the Archivist: source of truth · the inbox-today picture ----
// Headline numbers come from the CANONICAL VIEW (core/render_board.py build_view —
// the exact object /inbox-check prints and the cockpit renders). A pure local read
// of the persisted certified board; no engine run, no IMAP. Never raw board.json
// re-derivation (that path once showed "we owe a reply: 0" off a count key that
// doesn't exist) and never the 17-day-stale inbox-buckets.json snapshot.
async function smokeArchivist(): Promise<AgentReport> {
  const checks: Check[] = [];
  const headline: AgentReport["headline"] = [];
  interface ViewLite {
    certified?: boolean;
    cert?: { mode?: string };
    sections?: { id: string; rows?: unknown[] }[];
    counts?: Record<string, number>;
    meta?: { today?: string; actionable?: number; companies_total?: number };
  }
  let view: ViewLite | null = null;
  const v = await run(PY, ["render_board.py", "--json"], { cwd: "/opt/velab/core", timeout: 30_000 });
  try { view = JSON.parse(v.stdout) as ViewLite; } catch { /* handled below */ }
  const ledger = await readJSON(`${VAULT}/pipeline/cadence/ledger.json`);

  let attention = 0;
  if (view?.meta) {
    const rows = (id: string) => view?.sections?.find((s) => s.id === id)?.rows?.length ?? 0;
    const owed = rows("reply");
    const nudges = rows("nudge");
    const closeouts = rows("closeout");
    attention = owed + nudges + closeouts;
    checks.push({
      label: "certified board",
      level: view.certified ? "ok" : "warn",
      detail: `as of ${view.meta.today ?? "—"} · ${view.certified ? `certified (${view.cert?.mode ?? "?"})` : "NOT certified — treat numbers as unverified"}`,
    });
    headline.push(
      { label: "companies on the board", value: String(view.meta.companies_total ?? "—") },
      { label: "actionable", value: String(view.meta.actionable ?? "—") },
      { label: "need attention today", value: String(attention) },
      { label: "answers owed", value: String(owed) },
      { label: "gone quiet — nudge due", value: String(nudges) },
      { label: "close-outs proposed", value: String(closeouts) },
      { label: "cold follow-ups due", value: String(view.counts?.cold_due ?? "—") },
    );
    checks.push({
      label: "today's action",
      level: attention > 0 ? "warn" : "ok",
      detail: attention > 0 ? `${attention} need attention today (${owed} answers owed, ${nudges} to nudge, ${closeouts} close-outs to review)` : "nothing owed right now",
    });
  } else {
    checks.push({ label: "certified board", level: "fail", detail: "board view unavailable — run an inbox check" });
  }
  checks.push(
    ledger
      ? { label: "cadence ledger.json", level: "ok", detail: "present, parseable" }
      : { label: "cadence ledger.json", level: "fail", detail: "missing" },
  );
  const age = await mtimeAgeHours(`${VAULT}/state/board.json`);
  if (age !== null) checks.push({
    label: "freshness",
    level: age > 72 ? "warn" : "ok",
    detail: `regenerated ${age < 1 ? "<1h" : Math.round(age) + "h"} ago`,
  });

  // sharded inbox-corpus: the truth backbone behind /inbox-check (corpus-reconcile + corpus-today)
  const cp = await corpusHealth();
  checks.push({
    label: "corpus pull (sharded)",
    level: cp.ageMin === null ? "fail" : cp.ageMin > 390 ? "warn" : "ok", // reconcile every 6h
    detail: cp.ageMin === null
      ? "no successful pull on record"
      : `last ${cp.lastMode} pull ${cp.ageMin < 60 ? Math.round(cp.ageMin) + "m" : (cp.ageMin / 60).toFixed(1) + "h"} ago (${cp.lastStatus})`,
  });
  checks.push({
    label: "corpus coverage",
    level: cp.holes < 0 ? "warn" : cp.holes > 0 ? "fail" : "ok",
    detail: cp.holes < 0
      ? "coverage registry absent — can't prove completeness"
      : cp.holes > 0
        ? `${cp.holes} unpulled day(s) since ${CORPUS_SINCE} — board would miss replies there`
        : `complete since ${CORPUS_SINCE}`,
  });
  headline.push({ label: "corpus coverage holes", value: cp.holes < 0 ? "—" : String(cp.holes) });

  return {
    agent: "archivist",
    status: worst(checks),
    summary: view?.meta
      ? `board read OK · ${attention} need attention today`
      : "could not read the certified board",
    checks,
    headline,
  };
}

// ---- the Scraper: lead inventory ----
async function smokeScraper(): Promise<AgentReport> {
  const checks: Check[] = [];
  const verified = await countDir(`${VAULT}/leads/verified`);
  const deferred = await countDir(`${VAULT}/leads/deferred`);
  checks.push(
    verified >= 0
      ? { label: "leads/verified", level: "ok", detail: `${verified} verified lead files` }
      : { label: "leads/verified", level: "fail", detail: "dir missing" },
  );
  let lastStat = "";
  try {
    const stats = (await fs.readFile(`${VAULT}/leads/discovery-stats.jsonl`, "utf8")).trim().split("\n");
    const last = JSON.parse(stats[stats.length - 1]) as { ts: string; country: string; new_candidates: number };
    lastStat = `${last.country}: +${last.new_candidates} (${last.ts.slice(0, 10)})`;
    checks.push({ label: "discovery-stats", level: "ok", detail: `last pass — ${lastStat}` });
  } catch {
    checks.push({ label: "discovery-stats", level: "warn", detail: "no discovery history" });
  }
  const reacher = await pexec("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true")
    .then((r) => r.stdout.trim()).catch(() => "000");
  checks.push({
    label: "Reacher verifier",
    level: reacher === "000" ? "warn" : "ok",
    detail: reacher === "000" ? "not responding (start before a pass)" : `up (HTTP ${reacher})`,
  });
  return {
    agent: "scraper",
    status: worst(checks),
    summary: `${verified} verified leads on hand`,
    checks,
    headline: [
      { label: "verified leads", value: String(verified) },
      { label: "deferred", value: deferred >= 0 ? String(deferred) : "—" },
      { label: "last pass", value: lastStat || "—" },
    ],
  };
}

// ---- the Mailman: outbound + the send-auth gate ----
async function smokeMailman(): Promise<AgentReport> {
  const checks: Check[] = [];
  const drafts = await countDir(`${VAULT}/pipeline/drafts`);
  checks.push(drafts >= 0
    ? { label: "pipeline/drafts", level: "ok", detail: `${drafts} staged draft artifacts` }
    : { label: "pipeline/drafts", level: "warn", detail: "no drafts dir" });

  // the spine: default-DENY send-auth must be present
  const approvals = await readJSON(`${VAULT}/pipeline/outbox/send-approvals.json`);
  checks.push(approvals !== null
    ? { label: "send-auth gate", level: "ok", detail: "approvals ledger present (default-DENY)" }
    : { label: "send-auth gate", level: "warn", detail: "approvals ledger absent — gate is fail-closed anyway" });

  const pause = (await readJSON(`${VAULT}/pipeline/reputation/send-pause.json`)) as { paused?: boolean } | null;
  const paused = pause?.paused === true;
  checks.push({
    label: "reputation kill-switch",
    level: paused ? "warn" : "ok",
    detail: paused ? "SENDING PAUSED" : "not paused",
  });
  const dnc = await pexec(`wc -l < ${VAULT}/suppression/dnc.jsonl`).then((r) => Number(r.stdout.trim())).catch(() => -1);
  checks.push(dnc >= 0
    ? { label: "DNC suppression", level: "ok", detail: `${dnc} do-not-contact entries loaded` }
    : { label: "DNC suppression", level: "warn", detail: "dnc list missing" });

  return {
    agent: "mailman",
    status: worst(checks),
    summary: paused ? "sending paused" : "outbound ready · send-auth gated",
    checks,
    headline: [
      { label: "staged drafts", value: String(drafts) },
      { label: "sending", value: paused ? "PAUSED" : "armed (gated)" },
      { label: "DNC entries", value: dnc >= 0 ? String(dnc) : "—" },
    ],
  };
}

// ---- the Steward: the CRM ----
async function smokeSteward(): Promise<AgentReport> {
  const checks: Check[] = [];
  const clients = await countDir(`${VAULT}/clients`);
  const meetings = await countDir(`${VAULT}/meetings`);
  checks.push(clients >= 0
    ? { label: "clients/ dossiers", level: "ok", detail: `${clients} client records` }
    : { label: "clients/", level: "fail", detail: "dir missing" });
  checks.push(meetings >= 0
    ? { label: "meetings/", level: "ok", detail: `${meetings} meeting records` }
    : { label: "meetings/", level: "warn", detail: "no meetings dir" });
  return {
    agent: "steward",
    status: worst(checks),
    summary: `${clients} clients · ${meetings} meetings tracked`,
    checks,
    headline: [
      { label: "clients", value: String(clients) },
      { label: "meetings", value: String(meetings) },
    ],
  };
}

// ---- the Nightkeeper: declared-vs-actual job health ----
async function smokeNightkeeper(): Promise<AgentReport> {
  const checks: Check[] = [];
  let active = 0, failed = 0, lines: string[] = [];
  try {
    const { stdout } = await pexec("systemctl list-timers --all --no-legend 2>/dev/null | grep -iE 'velab|valence' || true");
    lines = stdout.trim().split("\n").filter(Boolean);
    active = lines.length;
  } catch { /* */ }
  try {
    const { stdout } = await pexec("systemctl --failed --no-legend 2>/dev/null | grep -iE 'velab|valence' || true");
    failed = stdout.trim().split("\n").filter(Boolean).length;
  } catch { /* */ }
  checks.push(active > 0
    ? { label: "scheduled timers", level: "ok", detail: `${active} velab/valence timers registered` }
    : { label: "scheduled timers", level: "warn", detail: "no timers found" });
  checks.push(failed === 0
    ? { label: "failed units", level: "ok", detail: "none in failed state" }
    : { label: "failed units", level: "fail", detail: `${failed} unit(s) failed` });
  // console's own services
  const consoleUp = await pexec("systemctl is-active valence-console 2>/dev/null || true").then((r) => r.stdout.trim());
  checks.push({ label: "console service", level: consoleUp === "active" ? "ok" : "warn", detail: `valence-console: ${consoleUp}` });
  return {
    agent: "nightkeeper",
    status: worst(checks),
    summary: failed === 0 ? `${active} timers healthy` : `${failed} failed unit(s)`,
    checks,
    headline: [
      { label: "timers", value: String(active) },
      { label: "failed units", value: String(failed) },
    ],
  };
}

// ---- Valence: central rollup ----
function smokeValence(reports: AgentReport[]): AgentReport {
  const oks = reports.filter((r) => r.status === "ok").length;
  const fails = reports.filter((r) => r.status === "fail").length;
  const checks: Check[] = reports.map((r) => ({
    label: r.agent,
    level: r.status,
    detail: r.summary,
  }));
  return {
    agent: "valence",
    status: fails > 0 ? "fail" : oks === reports.length ? "ok" : "warn",
    summary: `${oks}/${reports.length} agents green${fails ? ` · ${fails} failing` : ""}`,
    checks,
    headline: [
      { label: "agents green", value: `${oks}/${reports.length}` },
      { label: "failing", value: String(fails) },
    ],
  };
}

export async function GET() {
  const workers = await Promise.all([
    smokeArchivist(),
    smokeScraper(),
    smokeMailman(),
    smokeSteward(),
    smokeNightkeeper(),
  ]);
  const valence = smokeValence(workers);
  const byId: Record<string, AgentReport> = {};
  [valence, ...workers].forEach((r) => (byId[r.agent] = r));
  return NextResponse.json({ ranAt: Date.now(), reports: byId });
}
