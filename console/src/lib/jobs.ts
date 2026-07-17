// Server-only job runner for the cockpit. The send + stage pipelines are far too
// slow to run inside an HTTP request (send_batch sleeps ~65s PER recipient; the
// stage chain opens real IMAP connections). So we spawn them DETACHED, redirect
// stdout/stderr to files, and write a done-file with the exit code on completion.
// The API returns a jobId immediately; the client polls /api/job?id=… .
//
// This mirrors the proven Venus-console `.runmon`/done-file pattern. Injection-safe:
// the command is passed as an argv array via bash "$@" (never string-interpolated),
// and file paths travel as env vars so no quoting is involved.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RUNS_DIR = "/opt/velab/workspace/runs/console-jobs";

// Human context the task tray renders. Written into the job's meta.json at
// start time so the tray can explain a job to the operator without parsing
// argv. `title` is plain words, layperson-legible (doctrine).
export interface JobContext {
  kind: "send" | "stage" | "rewrite" | "scraping" | "refresh" | "other";
  title: string;
  packFile?: string; // drafts pack this task belongs to, when there is one
  total?: number; // recipient/draft count, when known
  view?: string; // console view where this task's context lives (default cockpit)
}

export interface JobSpec {
  label: string; // short kind, e.g. "send", "stage", "meeting"
  argv: string[]; // [executable, ...args] — argv[0] is the program
  cwd?: string;
  context?: JobContext;
}

export interface JobStatus {
  id: string;
  label: string;
  argv: string[];
  startedAt: number;
  running: boolean;
  code: number | null; // exit code once done
  endedAt: number | null;
  out: string; // tail of stdout
  err: string; // tail of stderr
  context?: JobContext;
}

function ensureDir() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function paths(id: string) {
  return {
    meta: path.join(RUNS_DIR, `${id}.meta.json`),
    out: path.join(RUNS_DIR, `${id}.out`),
    err: path.join(RUNS_DIR, `${id}.err`),
    done: path.join(RUNS_DIR, `${id}.done`),
  };
}

// validate an id coming from a client before touching the filesystem
const ID_RE = /^[a-z0-9][a-z0-9_-]{2,80}$/;
export function validJobId(id: string): boolean {
  return ID_RE.test(id);
}

export function startJob(spec: JobSpec): string {
  ensureDir();
  const id = `${spec.label}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const p = paths(id);
  fs.writeFileSync(
    p.meta,
    JSON.stringify({
      id, label: spec.label, argv: spec.argv, cwd: spec.cwd ?? null, startedAt: Date.now(),
      ...(spec.context ? { context: spec.context } : {}),
    }),
  );
  // bash wraps the argv so we can capture the exit code into a done-file after the
  // parent (this request) has already returned. $@ starts at the program name.
  const script = '"$@" >"$JOB_OUT" 2>"$JOB_ERR"; echo $? >"$JOB_DONE"';
  const child = spawn("bash", ["-c", script, "velab-job", ...spec.argv], {
    cwd: spec.cwd ?? "/opt/velab/workspace",
    detached: true,
    stdio: "ignore",
    env: { ...process.env, JOB_OUT: p.out, JOB_ERR: p.err, JOB_DONE: p.done },
  });
  child.unref();
  return id;
}

function tail(file: string, max = 16000): string {
  try {
    const s = fs.readFileSync(file, "utf8");
    return s.length > max ? s.slice(-max) : s;
  } catch {
    return "";
  }
}

export function jobStatus(id: string): JobStatus | null {
  const p = paths(id);
  let meta: { label?: string; argv?: string[]; startedAt?: number; context?: JobContext };
  try {
    meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
  } catch {
    return null;
  }
  let code: number | null = null;
  let endedAt: number | null = null;
  if (fs.existsSync(p.done)) {
    const raw = fs.readFileSync(p.done, "utf8").trim();
    code = raw === "" ? null : Number.parseInt(raw, 10);
    try {
      endedAt = fs.statSync(p.done).mtimeMs;
    } catch {
      endedAt = Date.now();
    }
  }
  return {
    id,
    label: meta.label ?? "job",
    argv: meta.argv ?? [],
    startedAt: meta.startedAt ?? 0,
    running: code === null,
    code,
    endedAt,
    out: tail(p.out),
    err: tail(p.err),
    ...(meta.context ? { context: meta.context } : {}),
  };
}

// Every job started in the last `windowMs`, newest first — the task tray's
// disk-backed universe (survives page reloads and console restarts).
export function listJobs(windowMs: number): JobStatus[] {
  ensureDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(RUNS_DIR).filter((n) => n.endsWith(".meta.json"));
  } catch {
    return [];
  }
  const cutoff = Date.now() - windowMs;
  const out: JobStatus[] = [];
  for (const n of names) {
    const id = n.replace(/\.meta\.json$/, "");
    if (!validJobId(id)) continue;
    const st = jobStatus(id);
    if (!st) continue;
    if ((st.endedAt ?? st.startedAt) < cutoff && !st.running) continue;
    out.push(st);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

// Dismissal markers — a failed task stays in the tray until the operator
// explicitly dismisses it (marker file survives reloads and restarts).
export function dismissTask(id: string): boolean {
  if (!validJobId(id)) return false;
  ensureDir();
  try {
    fs.writeFileSync(path.join(RUNS_DIR, `${id}.dismissed`), new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

export function isDismissed(id: string): boolean {
  if (!validJobId(id)) return false;
  return fs.existsSync(path.join(RUNS_DIR, `${id}.dismissed`));
}
