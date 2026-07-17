"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, KV, RowItem, RowList, StatusPill, TabBar, toneMix, type Tone } from "@/components/kit";
import { humanJobName, humanCommitMsg } from "@/lib/jobNames";
import type { AgentReport } from "@/lib/status";
import type { ActivityEvent } from "@/lib/activity";
import { CronDetail } from "./CronDetail";
import { ScheduleTimeline } from "./ScheduleTimeline";
import { OrgChart } from "./OrgChart";
import { ActivityLog } from "./ActivityLog";
import { SmokeReport } from "./SmokeReport";

interface Health {
  ranAt: number;
  backups: {
    ok: boolean; timerActive: boolean; schedule: string;
    lastTrigger: number | null; nextTrigger: number | null;
    count: number; keep: number | null; totalBytes: number;
    latest: { bytes: number; mtime: number } | null;
    snapshots: { bytes: number; mtime: number }[];
  };
  offsite: {
    ok: boolean; branch: string;
    lastCommitTs: number | null; lastCommitMsg: string;
    lastCommitHash: string | null; lastCommitAuthor: string | null;
    dirtyFiles: number; totalCommits: number; repoSize: string | null;
    history: { ts: number; hash: string; msg: string }[];
    pushServiceLast: number | null;
  };
  integrity: { wipeGuard: boolean; skillsFloor: number | null; memoryFloor: number | null; retention: string | null };
  vault: { files: number; sizeHuman: string; mdFiles: number };
}

interface Job {
  unit: string; base: string; kind: "timer" | "service"; triggers: string | null;
  description: string; schedule: string; cadence: { label: string; approxSec: number }; persistent: boolean;
  owner: { id: string; name: string; color: string } | null;
  state: string; last: number | null; next: number | null; system: boolean;
}
interface Owner { id: string; name: string; color: string }
interface Crons { ranAt: number; counts: { total: number; agent: number; system: number }; owners: Owner[]; jobs: Job[] }
type SortKey = "next" | "last" | "frequency" | "name";

const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`;
function ago(ms: number | null) {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 0) return `in ${Math.abs(Math.floor(s / 60))}m`;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function until(ms: number | null) {
  if (!ms) return "—";
  const s = Math.floor((ms - Date.now()) / 1000);
  if (s < 0) return "due";
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d`;
}
function abs(ms: number | null) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
const STATE_TONE: Record<string, Tone> = { active: "ok", inactive: "dim", failed: "bad", unknown: "dim" };

function RefreshBtn({ loading, onClick, small }: { loading: boolean; onClick: () => void; small?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading}
      className={`rounded-ctl border border-line-strong bg-fill-2 text-ink transition-colors hover:bg-fill-3 disabled:opacity-50 ${small ? "px-2.5 py-1 text-caption" : "px-3 py-1.5 text-caption"}`}>
      {loading ? "…" : "↻ refresh"}
    </button>
  );
}

// ───────────────────────── overview ─────────────────────────
function HealthOverview({ onOpenJob }: { onOpenJob: (unit: string, color: string) => void }) {
  const [h, setH] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [showSnaps, setShowSnaps] = useState(false);
  const [nonce, setNonce] = useState(0);
  const load = useCallback(() => {
    setLoading(true); setErr(false);
    setNonce((n) => n + 1);
    fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(20_000) })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setH(d))
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="thin-scroll h-full overflow-y-auto px-5 py-6 sm:px-8">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-5 flex justify-end">
          <RefreshBtn loading={loading} onClick={load} />
        </div>
        <div className="mb-4"><ScheduleTimeline nonce={nonce} onOpenJob={onOpenJob} /></div>

        {!h ? (
          <div className="glass rounded-pane p-8 text-center text-body text-ink-dim">
            {loading ? "reading backup state…" : err ? (
              <span className="text-tone-bad-ink">The health API didn&apos;t respond. <button onClick={load} className="underline underline-offset-2">Retry</button></span>
            ) : "no data"}
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {/* local backups */}
            <Card title="Local snapshots" pill={<StatusPill tone={h.backups.ok ? "ok" : "bad"} label={h.backups.ok ? "current" : "stale"} />}>
              <div className="grid grid-cols-3 gap-3">
                <KV k="last backup" v={ago(h.backups.lastTrigger)} />
                <KV k="next run" v={until(h.backups.nextTrigger)} />
                <KV k="schedule" v={h.backups.schedule.split(" ")[0]} />
                <KV k="snapshots" v={`${h.backups.count}${h.backups.keep ? `/${h.backups.keep}` : ""}`} />
                <KV k="total size" v={mb(h.backups.totalBytes)} />
                <KV k="timer" v={h.backups.timerActive ? "active" : "off"} />
              </div>
              {h.backups.latest && (
                <div className="mt-3 rounded-ctl border border-line bg-fill-1 px-3 py-2">
                  <div className="text-caption text-ink">Backup · {abs(h.backups.latest.mtime)} · {mb(h.backups.latest.bytes)}</div>
                  <div className="mt-0.5 text-micro text-ink-dim">{ago(h.backups.latest.mtime)}</div>
                </div>
              )}
              {h.backups.snapshots.length > 1 && (
                <>
                  <button onClick={() => setShowSnaps((s) => !s)} className="mt-2.5 text-micro text-ink-dim hover:text-ink">
                    {showSnaps ? "▾ HIDE" : "▸ SHOW"} ALL {h.backups.snapshots.length} SNAPSHOTS
                  </button>
                  {showSnaps && (
                    <ul className="thin-scroll mt-2 max-h-[180px] overflow-y-auto">
                      {h.backups.snapshots.map((s) => (
                        <li key={s.mtime} className="flex items-center justify-between gap-3 border-b border-line py-1 text-micro">
                          <span className="truncate text-ink-dim">Backup · {abs(s.mtime)}</span>
                          <span className="shrink-0 text-ink-dim">{mb(s.bytes)} · {ago(s.mtime)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Card>

            {/* off-server mirror (granular) */}
            <Card title="Off-server GitHub mirror" pill={<StatusPill tone={h.offsite.ok ? "ok" : "bad"} label={h.offsite.ok ? "pushed" : "behind"} />}>
              <div className="grid grid-cols-3 gap-3">
                <KV k="last push" v={ago(h.offsite.lastCommitTs)} />
                <KV k="branch" v={h.offsite.branch || "—"} />
                <KV k="uncommitted" v={String(h.offsite.dirtyFiles)} />
                <KV k="total commits" v={h.offsite.totalCommits ? h.offsite.totalCommits.toLocaleString() : "—"} />
                <KV k="repo size" v={h.offsite.repoSize || "—"} />
                <KV k="verification hook" v={h.offsite.pushServiceLast ? ago(h.offsite.pushServiceLast) : "not yet run"} />
              </div>
              <div className="mt-3 rounded-ctl border border-line bg-fill-1 px-3 py-2">
                <div className="text-caption text-ink">Off-server mirror · GitHub (private)</div>
                <div className="mt-1 truncate text-caption text-ink-dim">{humanCommitMsg(h.offsite.lastCommitMsg)}</div>
                <div className="mt-0.5 text-micro text-ink-dim">{abs(h.offsite.lastCommitTs)} · {ago(h.offsite.lastCommitTs)}</div>
              </div>
              {h.offsite.history.length > 1 && (
                <div className="mt-2.5">
                  <div className="eyebrow mb-1">RECENT PUSHES</div>
                  <ul className="flex flex-col gap-0.5">
                    {h.offsite.history.slice(0, 6).map((c) => (
                      <li key={c.hash} className="flex items-center gap-2 text-micro">
                        <span className="w-[64px] shrink-0 text-ink-dim">{ago(c.ts)}</span>
                        <span className="truncate text-caption text-ink-dim">{humanCommitMsg(c.msg)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>

            {/* integrity guards */}
            <Card title="Integrity guards" pill={<StatusPill tone={h.integrity.wipeGuard ? "ok" : "bad"} label={h.integrity.wipeGuard ? "armed" : "off"} />}>
              <ul className="flex flex-col gap-2 text-caption text-ink-dim">
                <li className="flex items-center justify-between"><span className="text-ink">Safety floors</span><span className="text-caption text-ink-dim">keep ≥ {h.integrity.skillsFloor ?? "?"} skills and ≥ {h.integrity.memoryFloor ?? "?"} memory files</span></li>
                <li className="flex items-center justify-between"><span className="text-ink">Retention</span><span className="text-caption text-ink-dim">{h.integrity.retention ?? "—"}</span></li>
                <li className="flex items-center justify-between"><span className="text-ink">Backup chain</span><span className="text-caption text-tone-ok-ink">local snapshot, then off-server mirror (3 stages)</span></li>
              </ul>
            </Card>

            {/* vault footprint */}
            <Card title="Vault footprint">
              <div className="grid grid-cols-3 gap-3">
                <KV k="files" v={h.vault.files.toLocaleString("en-US")} />
                <KV k="size" v={h.vault.sizeHuman || "—"} />
                <KV k="notes" v={h.vault.mdFiles.toLocaleString("en-US")} />
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── scheduled jobs ─────────────────────────
function JobRow({ j, onClick }: { j: Job; onClick: () => void }) {
  const c = j.owner?.color ?? "var(--tone-neutral)";
  return (
    <RowItem onClick={onClick}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c, boxShadow: j.owner ? `0 0 7px ${c}` : "none" }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-caption font-medium text-ink">{humanJobName(j.base)}</span>
          <span className="shrink-0 rounded-full border border-line px-1.5 text-micro text-ink-dim">{j.cadence.label}</span>
        </div>
        {j.description && <p className="truncate text-caption text-ink-dim" title={j.description}>{j.description}</p>}
      </div>
      <div className="hidden w-[110px] shrink-0 text-right sm:block">
        <div className="font-mono text-caption text-ink-dim">{j.owner?.name ?? "system"}</div>
        <div className="font-mono text-micro text-ink-dim">owner</div>
      </div>
      <div className="w-[110px] shrink-0 text-right">
        <div className="font-mono text-micro text-ink-dim">last {ago(j.last)}</div>
        <div className="font-mono text-micro text-ink-dim">next {until(j.next)}</div>
      </div>
      <div className="w-[64px] shrink-0 text-right"><StatusPill tone={STATE_TONE[j.state] ?? "dim"} label={j.state} /></div>
      <span className="shrink-0 text-body text-ink-dim">›</span>
    </RowItem>
  );
}

function ScheduledJobs({ focus, onFocusHandled }: { focus: { unit: string; color: string } | null; onFocusHandled: () => void }) {
  const [c, setC] = useState<Crons | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [ownerFilter, setOwnerFilter] = useState<string>("all"); // "all" | "system" | agentId
  const [sort, setSort] = useState<SortKey>("next");
  const [open, setOpen] = useState<{ unit: string; color: string } | null>(null);
  const load = useCallback(() => {
    setLoading(true); setErr(false);
    fetch("/api/crons", { cache: "no-store", signal: AbortSignal.timeout(20_000) })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setC(d))
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  // arriving from a timeline-node click → open that job's detail
  useEffect(() => { if (focus) { setOpen(focus); onFocusHandled(); } }, [focus, onFocusHandled]);

  const jobs = useMemo(() => {
    if (!c) return [];
    let js = c.jobs;
    if (ownerFilter === "system") js = js.filter((j) => j.system);
    else if (ownerFilter !== "all") js = js.filter((j) => j.owner?.id === ownerFilter);
    const sorted = [...js].sort((a, b) => {
      if (sort === "name") return a.base.localeCompare(b.base);
      if (sort === "frequency") return a.cadence.approxSec - b.cadence.approxSec;
      if (sort === "last") return (b.last ?? 0) - (a.last ?? 0);
      return (a.next ?? Infinity) - (b.next ?? Infinity); // next
    });
    return sorted;
  }, [c, ownerFilter, sort]);

  const SORTS: { k: SortKey; label: string }[] = [
    { k: "next", label: "Next fire" },
    { k: "last", label: "Last run" },
    { k: "frequency", label: "How often" },
    { k: "name", label: "Name" },
  ];

  return (
    <div className="thin-scroll h-full overflow-y-auto px-5 py-6 sm:px-8">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-3 text-caption text-ink-dim">
            {c && <><span><span className="text-ink-dim">{c.counts.total}</span> jobs</span><span>·</span><span><span className="text-ink-dim">{c.counts.agent}</span> agent-owned</span><span>·</span><span><span className="text-ink-dim">{c.counts.system}</span> system</span></>}
          </div>
          <RefreshBtn loading={loading} onClick={load} />
        </div>

        {!c ? (
          <div className="glass rounded-pane p-8 text-center text-body text-ink-dim">
            {loading ? "reading scheduled jobs…" : err ? (
              <span className="text-tone-bad-ink">The jobs API didn&apos;t respond. <button onClick={load} className="underline underline-offset-2">Retry</button></span>
            ) : "no data"}
          </div>
        ) : (
          <>
            {/* controls */}
            <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3">
              {/* agent filter chips */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="eyebrow mr-1">agent</span>
                <FilterChip label="All" active={ownerFilter === "all"} onClick={() => setOwnerFilter("all")} />
                {c.owners.map((o) => (
                  <FilterChip key={o.id} label={o.name} color={o.color} active={ownerFilter === o.id} onClick={() => setOwnerFilter(o.id)} />
                ))}
                <FilterChip label="System" active={ownerFilter === "system"} onClick={() => setOwnerFilter("system")} />
              </div>
              {/* sort */}
              <div className="flex items-center gap-1.5">
                <span className="eyebrow mr-1">sort</span>
                {SORTS.map((s) => (
                  <button key={s.k} onClick={() => setSort(s.k)} className={`rounded-full px-2.5 py-1 text-caption transition-colors ${sort === s.k ? "bg-fill-3 text-ink" : "text-ink-dim hover:text-ink"}`}>{s.label}</button>
                ))}
              </div>
            </div>

            <RowList>
              {jobs.length === 0 ? <p className="text-caption text-ink-dim">no jobs match this filter</p>
                : jobs.map((j) => <JobRow key={j.unit} j={j} onClick={() => setOpen({ unit: j.unit, color: j.owner?.color ?? "var(--tone-neutral)" })} />)}
            </RowList>
          </>
        )}
      </div>
      {open && <CronDetail unit={open.unit} color={open.color} onClose={() => setOpen(null)} />}
    </div>
  );
}

function FilterChip({ label, color, active, onClick }: { label: string; color?: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption transition-colors ${active ? "text-ink" : "text-ink-dim hover:text-ink"}`}
      style={{
        borderColor: active ? toneMix(color ?? "var(--ink-dim)", 45) : "var(--line)",
        background: active ? toneMix(color ?? "var(--ink)", 12) : "transparent",
      }}>
      {color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {label}
    </button>
  );
}

// ───────────────────────── shell ─────────────────────────
// System = one flat sub-tab row (operator ruling 2026-07-12: the Workspace tab
// is gone — the org chart lives here now, and the agent activity log + smoke
// checks moved here with it; the vault graph moved to the Vault tab).
type Sub = "overview" | "jobs" | "org" | "activity";

export interface SmokeState {
  reports: Record<string, AgentReport>;
  ranAt: number | null;
  running: boolean;
  run: () => void;
}

export function HealthView({ events, smoke }: { events: ActivityEvent[]; smoke: SmokeState }) {
  const [sub, setSub] = useState<Sub>("overview");
  const [focus, setFocus] = useState<{ unit: string; color: string } | null>(null);
  const openJob = useCallback((unit: string, color: string) => { setFocus({ unit, color }); setSub("jobs"); }, []);
  return (
    <div className="flex h-full flex-col px-5 pt-4 sm:px-8">
      <div className="mb-1 flex items-center justify-between">
        <div>
          <h2 className="text-title font-medium tracking-tight text-ink">System</h2>
          <p className="eyebrow mt-1">backups · scheduled jobs · the agent team · live checks</p>
        </div>
        <TabBar
          tabs={[
            { id: "overview" as Sub, label: "Health" },
            { id: "jobs" as Sub, label: "Scheduled jobs" },
            { id: "org" as Sub, label: "Org chart" },
            { id: "activity" as Sub, label: "Activity & checks" },
          ]}
          active={sub}
          onChange={setSub}
        />
      </div>
      <div className="-mx-5 min-h-0 flex-1 sm:-mx-8">
        {sub === "overview" && <HealthOverview onOpenJob={openJob} />}
        {sub === "jobs" && <ScheduledJobs focus={focus} onFocusHandled={() => setFocus(null)} />}
        {sub === "org" && <OrgChart />}
        {sub === "activity" && (
          <div className="thin-scroll h-full overflow-y-auto">
            <SmokeReport reports={smoke.reports} ranAt={smoke.ranAt} running={smoke.running} onRun={smoke.run} />
            <ActivityLog events={events} />
          </div>
        )}
      </div>
    </div>
  );
}
