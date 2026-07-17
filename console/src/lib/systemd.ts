// Server-only systemd helpers shared by /api/agent, /api/crons, /api/cron.
// Never import from a client component.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function parseSdTime(v?: string): number | null {
  if (!v || v === "n/a" || v.trim() === "") return null;
  const t = Date.parse(v.trim());
  return Number.isNaN(t) ? null : t;
}

// systemctl show → first occurrence of each key
export async function showUnit(unit: string, props: string[]): Promise<Record<string, string>> {
  try {
    const { stdout } = await exec("systemctl", ["show", unit, ...props.flatMap((p) => ["-p", p]), "--no-pager"], { timeout: 5000 });
    const kv: Record<string, string> = {};
    for (const line of stdout.split("\n")) { const i = line.indexOf("="); if (i > 0 && kv[line.slice(0, i)] === undefined) kv[line.slice(0, i)] = line.slice(i + 1); }
    return kv;
  } catch { return {}; }
}
async function showRaw(unit: string, props: string[]): Promise<string> {
  try { return (await exec("systemctl", ["show", unit, ...props.flatMap((p) => ["-p", p]), "--no-pager"], { timeout: 5000 })).stdout; } catch { return ""; }
}

// all OnCalendar expressions for a timer (a timer can have several)
export async function onCalendar(timer: string): Promise<string[]> {
  const raw = await showRaw(timer, ["TimersCalendar"]);
  return [...raw.matchAll(/OnCalendar=([^;]+?)\s*;/g)].map((m) => m[1].trim());
}

export interface ResolvedUnit {
  unit: string; kind: "timer" | "service"; state: string;
  last: number | null; next: number | null;
  description: string; schedule: string[]; persistent: boolean;
  triggers: string | null; fragmentPath: string;
}

// Resolve a bare base name to its live unit (prefer .timer, fall back .service).
export async function resolveBase(base: string): Promise<ResolvedUnit | null> {
  // timer first
  const tkv = await showUnit(`${base}.timer`, ["LoadState", "ActiveState", "LastTriggerUSec", "NextElapseUSecRealtime", "Persistent", "Unit", "Description", "FragmentPath"]);
  if (tkv.LoadState === "loaded") {
    const cals = await onCalendar(`${base}.timer`);
    const triggers = tkv.Unit || `${base}.service`;
    let description = tkv.Description || "";
    if (!description || /timer/i.test(description)) {
      const skv = await showUnit(triggers, ["Description"]);
      if (skv.Description) description = skv.Description;
    }
    return {
      unit: `${base}.timer`, kind: "timer", state: tkv.ActiveState || "unknown",
      last: parseSdTime(tkv.LastTriggerUSec), next: parseSdTime(tkv.NextElapseUSecRealtime),
      description, schedule: cals, persistent: tkv.Persistent === "yes",
      triggers, fragmentPath: tkv.FragmentPath || "",
    };
  }
  // service
  const skv = await showUnit(`${base}.service`, ["LoadState", "ActiveState", "LastTriggerUSec", "ActiveEnterTimestamp", "Description", "FragmentPath"]);
  if (skv.LoadState === "loaded") {
    const active = skv.ActiveState === "active";
    return {
      unit: `${base}.service`, kind: "service", state: skv.ActiveState || "unknown",
      last: parseSdTime(skv.LastTriggerUSec) ?? parseSdTime(skv.ActiveEnterTimestamp), next: null,
      description: skv.Description || "", schedule: [active ? "always-on" : "event-driven"],
      persistent: false, triggers: null, fragmentPath: skv.FragmentPath || "",
    };
  }
  return null;
}

// Enumerate the actual fire timestamps (ms) within the next `windowSec` for one
// or more OnCalendar expressions, using systemd-analyze (handles steps, comma
// lists, timezones, weekdays correctly). Merged + deduped + sorted.
export async function fireTimes(exprs: string[], windowSec: number, maxIter = 50): Promise<number[]> {
  const now = Date.now();
  const end = now + windowSec * 1000;
  const all: number[] = [];
  for (const expr of exprs) {
    if (expr === "always-on" || expr === "event-driven" || expr === "—") continue;
    try {
      const { stdout } = await exec("systemd-analyze", ["calendar", expr, `--iterations=${maxIter}`], { timeout: 5000 });
      for (const m of stdout.matchAll(/(?:Next elapse|Iteration #\d+):\s*(.+)/g)) {
        const t = Date.parse(m[1].trim());
        if (!Number.isNaN(t) && t >= now && t <= end) all.push(t);
      }
    } catch { /* */ }
  }
  return Array.from(new Set(all)).sort((a, b) => a - b);
}

export async function journal(unit: string, n: number): Promise<{ ts: number; source: string; text: string }[]> {
  try {
    const { stdout } = await exec("journalctl", ["-u", unit, "-n", String(n), "-o", "json", "--no-pager"], { timeout: 5000 });
    return stdout.trim().split("\n").filter(Boolean).map((l) => {
      try { const j = JSON.parse(l); return { ts: j.__REALTIME_TIMESTAMP ? Math.floor(Number(j.__REALTIME_TIMESTAMP) / 1000) : 0, source: unit, text: String(j.MESSAGE ?? "").slice(0, 300) }; } catch { return null; }
    }).filter(Boolean) as { ts: number; source: string; text: string }[];
  } catch { return []; }
}

// ── cadence: turn OnCalendar expressions into a human label + an approximate
// period in seconds (smaller = more frequent) for sorting "how often".
const WEEKDAYS = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i;
function stepOf(field: string): number | "*" | null {
  if (field === "*") return "*";
  const slash = field.match(/\/(\d+)/);
  if (slash) return Number(slash[1]);
  return null; // a fixed value
}
function periodOfEntry(entry: string): number | null {
  // non-calendar passthrough (services)
  if (!/[:]/.test(entry) && !WEEKDAYS.test(entry)) return null;
  const weekly = WEEKDAYS.test(entry.trim());
  // find the H:M:S clock token (the one with colons and digits/stars)
  const clock = entry.trim().split(/\s+/).find((t) => /[:]/.test(t) && /[\d*]/.test(t)) ?? "";
  const [h = "*", m = "0", s = "0"] = clock.split(":");
  const hs = stepOf(h), ms = stepOf(m), ss = stepOf(s);
  if (typeof ss === "number") return ss;
  if (typeof ms === "number") return ms * 60;
  if (ms === "*") return 60;
  if (typeof hs === "number") return hs * 3600;
  if (hs === "*") return 3600;
  // fixed time(s)-of-day — a comma list of hours means several fires per day
  const dayPeriod = weekly ? 604800 : 86400;
  const hourCount = h.split(",").length;
  return hourCount > 1 ? Math.round(dayPeriod / hourCount) : dayPeriod;
}
function humanPeriod(sec: number): string {
  if (sec < 60) return `every ${sec}s`;
  if (sec < 3600) { const m = Math.round(sec / 60); return m === 1 ? "every minute" : `every ${m} min`; }
  if (sec < 86400) { const h = Math.round(sec / 3600); return h === 1 ? "hourly" : `every ${h}h`; }
  if (sec < 604800) { const d = Math.round(sec / 86400); return d === 1 ? "daily" : `every ${d}d`; }
  return "weekly";
}
export function cadence(schedule: string[]): { label: string; approxSec: number } {
  if (schedule.length === 1 && (schedule[0] === "always-on" || schedule[0] === "event-driven")) {
    return { label: schedule[0], approxSec: schedule[0] === "always-on" ? 0 : Number.MAX_SAFE_INTEGER };
  }
  const periods = schedule.map(periodOfEntry).filter((p): p is number => p != null);
  if (periods.length === 0) return { label: "—", approxSec: Number.MAX_SAFE_INTEGER };
  // multiple fixed daily times → N×/day
  const allDaily = periods.every((p) => p === 86400);
  if (allDaily && periods.length > 1) {
    const n = periods.length;
    return { label: `${n}× daily`, approxSec: Math.round(86400 / n) };
  }
  const min = Math.min(...periods);
  return { label: humanPeriod(min), approxSec: min };
}
