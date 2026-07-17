import fs from "node:fs";
import path from "node:path";
import { listJobs, dismissTask, isDismissed, validJobId, type JobStatus } from "@/lib/jobs";
import { jobOk } from "@/lib/jobResult";
import { DRAFTS_DIR, readStagedAt } from "@/lib/pipeline";
import { fixture, fixturesOn } from "@/lib/fixtures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// THE ACTIVITY LOG'S TRUTH (operator rulings 2026-07-13; second ruling the
// same day upgraded the tray from live-only to a LOG): the console must
// always answer "what is the machine doing, what has it done, and did
// anything fail?" — across page reloads, closed modals and console restarts.
// Sources, all on disk:
//   - detached jobs (runs/console-jobs/*.meta.json — see lib/jobs.ts)
//   - staged-but-unsent packs (the human gap between checks passing and the
//     operator's send confirm; same staged/sent truth /api/drafts uses)
// Retention: running tasks always; failures pinned until explicitly
// dismissed; finished-ok tasks stay listed as log entries for the 48h window
// (also dismissable) — the operator watched a 25-minute send finish in Gmail
// and came back to an empty tray; that must never happen again.

const WINDOW_MS = 48 * 3600 * 1000;
const SENT_DIR = "/opt/velab/vault/pipeline/sent";

// cockpit_stage.sh step names -> plain words a zero-context reader understands
const STAGE_STEP_WORDS: Record<string, string> = {
  cadence_gate: "cadence check",
  recover_threads: "recovering conversations",
  thread_gate: "threading check",
  verify_drafts: "review cards",
  stage_drafts_in_gmail: "lining up in Gmail Drafts",
  verify_draft_threading: "final threading check",
};

export interface TaskRow {
  id: string;
  kind: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  running: boolean;
  ok: boolean | null; // null while running
  progress?: string; // plain words: current step / "12 of 28 delivered"
  done?: number; // structured progress — feeds the tray's filling bar
  total?: number;
  failure?: string; // the tool's own words, trimmed — only on failed rows
  packFile?: string;
  view?: string;
}

const STAGE_STEP_ORDER = Object.keys(STAGE_STEP_WORDS);

function stageProgress(out: string): { words: string; done: number; total: number } | null {
  const steps = [...out.matchAll(/^::STEP:: (\S+)/gm)];
  if (!steps.length) return null;
  const raw = steps[steps.length - 1][1];
  const idx = STAGE_STEP_ORDER.indexOf(raw);
  return {
    words: STAGE_STEP_WORDS[raw] ?? raw,
    done: idx >= 0 ? idx + 1 : steps.length,
    total: STAGE_STEP_ORDER.length,
  };
}

function sendProgress(out: string): { words: string; done: number; total: number } | null {
  const sent = [...out.matchAll(/^::(?:SENT|SENDFAIL):: (\d+)\/(\d+)/gm)];
  if (sent.length) {
    const last = sent[sent.length - 1];
    const done = Number(last[1]), total = Number(last[2]);
    return { words: `${done} of ${total} delivered`, done, total };
  }
  // fallback: the sender's final summary (jobs from before the ::SENT:: markers)
  const m = out.match(/"requested_to_send":\s*(\d+)[\s\S]*?"sent_now":\s*(\d+)/);
  if (m) {
    const total = Number(m[1]), done = Number(m[2]);
    return { words: `${done} of ${total} delivered`, done, total };
  }
  return null;
}

// The failure text is the TOOL'S OWN words (data honesty): everything after
// the last ::STEP:: marker, minus the machine markers, plus the stderr tail.
function failureText(st: JobStatus): string {
  let out = st.out;
  const lastStep = out.lastIndexOf("::STEP::");
  if (lastStep >= 0) {
    const nl = out.indexOf("\n", lastStep);
    out = nl >= 0 ? out.slice(nl + 1) : "";
  }
  out = out
    .split("\n")
    .filter((l) => !/^::(?:STEP|FAIL|WARN|SENT|SENDFAIL)::/.test(l) && !/^STAGE_RESULT|^WORKBENCH_RESULT/.test(l))
    .join("\n")
    .trim();
  const err = st.err.trim();
  const text = [out.slice(-1200), err ? `\n${err.slice(-400)}` : ""].join("").trim();
  return text || `The task ended with exit code ${st.code} and left no message.`;
}

function defaultTitle(st: JobStatus): string {
  const words: Record<string, string> = {
    stage: "Safety checks",
    send: "Sending emails",
    "send-refresh": "Updating the board from Gmail",
    "scraping-discover": "Scraping — finding sources",
    "scraping-qualify": "Scraping — qualifying companies",
    "scraping-scrape": "Scraping — reading sites",
    "scraping-verify": "Scraping — verifying leads",
    "scraping-icp": "Scraping — checking client fit",
    "workbench-titles": "Naming chat sessions",
  };
  return words[st.label] ?? (st.label.startsWith("workbench-") ? `Agent work — ${st.label.slice(10)}` : st.label);
}

function defaultKind(label: string): string {
  if (label === "send") return "send";
  if (label === "stage") return "stage";
  if (label === "send-refresh") return "refresh";
  if (label.startsWith("scraping")) return "scraping";
  if (label.startsWith("workbench")) return "rewrite";
  return "other";
}

function jobRows(): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const st of listJobs(WINDOW_MS)) {
    const ok = st.running ? null : jobOk(st.code, st.out);
    if (ok !== null && isDismissed(st.id)) continue; // any finished row is dismissable
    const kind = st.context?.kind ?? defaultKind(st.label);
    const p = kind === "stage" ? stageProgress(st.out) : kind === "send" ? sendProgress(st.out) : null;
    rows.push({
      id: st.id,
      kind,
      title: st.context?.title ?? defaultTitle(st),
      startedAt: st.startedAt,
      endedAt: st.endedAt,
      running: st.running,
      ok,
      ...(p ? { progress: p.words, done: p.done, total: p.total } : {}),
      ...(ok === false ? { failure: failureText(st) } : {}),
      ...(st.context?.packFile ? { packFile: st.context.packFile } : {}),
      view: st.context?.view ?? "cockpit",
    });
  }
  return rows;
}

// Packs whose checks passed (staged) but that were never sent: the operator
// still owes them a send confirm. Same staged/sent truth as /api/drafts.
function stagedWaitingRows(): TaskRow[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(DRAFTS_DIR).filter((n) => n.endsWith(".staged.json"));
  } catch {
    return [];
  }
  let sentBases: string[] = [];
  try {
    sentBases = fs.readdirSync(SENT_DIR).map((n) => n.replace(/\.json$/, ""));
  } catch { /* none */ }
  const cutoff = Date.now() - WINDOW_MS;
  const rows: TaskRow[] = [];
  for (const n of names) {
    const abs = path.join(DRAFTS_DIR, n);
    let mtime = 0;
    try { mtime = fs.statSync(abs).mtimeMs; } catch { continue; }
    if (mtime < cutoff) continue;
    const base = n.replace(/\.staged\.json$/, "");
    const packName = `${base}.json`;
    if (!fs.existsSync(path.join(DRAFTS_DIR, packName))) continue;
    if (sentBases.some((s) => s.includes(base) || base.includes(s.replace(/^\d{4}-\d{2}-\d{2}-/, "")))) continue;
    let pack: Record<string, unknown> | null = null;
    try { pack = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, packName), "utf8")); } catch { /* sidecar is enough */ }
    const stagedAt = readStagedAt(pack, abs);
    if (!stagedAt) continue;
    const count = pack ? (Object.values(pack).filter(Array.isArray) as unknown[][]).flat().length : 0;
    const id = `staged-${base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`.slice(0, 80);
    if (!validJobId(id) || isDismissed(id)) continue;
    rows.push({
      id,
      kind: "staged-waiting",
      title: count > 0 ? `${count} drafts staged — waiting for your send confirm` : "Drafts staged — waiting for your send confirm",
      startedAt: mtime,
      endedAt: null,
      running: false,
      ok: null,
      packFile: packName,
      view: "cockpit",
    });
  }
  return rows;
}

export async function GET() {
  if (fixturesOn()) return Response.json(fixture("tasks") ?? { tasks: [] });
  const tasks = [...jobRows(), ...stagedWaitingRows()].sort((a, b) => b.startedAt - a.startedAt);
  return Response.json({ tasks });
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { id?: string; action?: string };
  if (b.action !== "dismiss" || !b.id || !validJobId(b.id)) {
    return Response.json({ error: "need { id, action: \"dismiss\" }" }, { status: 400 });
  }
  return Response.json({ ok: dismissTask(b.id) });
}
