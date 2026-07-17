"use client";

import { humanJobName } from "@/lib/jobNames";
import { useCallback, useEffect, useRef, useState } from "react";
import { toneMix } from "@/components/kit";

interface SchedJob {
  base: string;
  owner: { id: string; name: string; color: string } | null;
  kind: "timer" | "service";
  state: string;
  cadence: { label: string; approxSec: number };
  next: number | null;
  continuous: boolean; eventDriven: boolean; highFreq: boolean;
  fires: number[];
}
interface Sched { now: number; windowSec: number; jobs: SchedJob[] }

function clock(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function ScheduleTimeline({ nonce, onOpenJob }: { nonce: number; onOpenJob: (unit: string, color: string) => void }) {
  const [s, setS] = useState<Sched | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const load = useCallback(() => {
    setLoading(true); setErr(false);
    // 20s cap: a hung API must resolve to an explicit error, never an eternal spinner
    fetch("/api/schedule", { cache: "no-store", signal: AbortSignal.timeout(20_000) })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setS(d))
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load, nonce]);

  const start = s?.now ?? Date.now();
  const span = (s?.windowSec ?? 86400) * 1000;
  const end = start + span;
  const pos = (ts: number) => Math.max(0, Math.min(100, ((ts - start) / span) * 100));

  // custom hover name-tag (native title is slow/unreliable)
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ label: string; sub?: string; x: number; y: number } | null>(null);
  const showTip = (e: React.MouseEvent, label: string, sub?: string) => {
    const wrap = wrapRef.current; if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTip({ label, sub, x: r.left - wr.left + r.width / 2, y: r.top - wr.top });
  };
  const hideTip = () => setTip(null);

  // hour gridlines
  const ticks: number[] = [];
  { const d = new Date(start); d.setMinutes(0, 0, 0); let t = d.getTime(); if (t < start) t += 3600_000; for (; t <= end; t += 3600_000) ticks.push(t); }

  return (
    <div className="glass rounded-pane p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>
          <h3 className="text-body font-medium text-ink">Next 24 hours</h3>
          <p className="mt-0.5 text-micro text-ink-dim">When each background job fires · {clock(start)} → {clock(end)}</p>
        </div>
        {/* legend up top — row/color meaning visible without scrolling (brief 2, #8) */}
        <div className="flex items-center gap-3 text-micro text-ink-dim" aria-label="Timeline legend">
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-ink-dim" /> FIRES</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-[3px] rounded bg-fill-3" /> HIGH-FREQUENCY</span>
          <span className="flex items-center gap-1"><span className="h-2 w-5 rounded-md border border-line bg-fill-2" /> ALWAYS ON</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-[2px] bg-tone-warn" /> NOW</span>
        </div>
        <button onClick={load} disabled={loading} className="rounded-ctl border border-line-strong bg-fill-2 px-2.5 py-1 text-caption text-ink transition-colors hover:bg-fill-3 disabled:opacity-50">{loading ? "…" : "↻"}</button>
      </div>

      {!s ? (
        <div className="py-6 text-center text-caption text-ink-dim">
          {loading ? "computing fire times…" : err ? (
            <span className="text-tone-bad-ink">The schedule API didn&apos;t respond. <button onClick={load} className="underline underline-offset-2">Retry</button></span>
          ) : "no data"}
        </div>
      ) : (
        <div ref={wrapRef} className="relative">
          {/* axis */}
          <div className="flex">
            <div className="w-[140px] shrink-0" />
            <div className="relative h-4 flex-1">
              {ticks.map((t) => {
                const h = new Date(t).getHours();
                const show = h % 3 === 0;
                return show ? (
                  <span key={t} className="absolute -translate-x-1/2 font-mono text-micro text-ink-dim" style={{ left: `${pos(t)}%` }}>{clock(t)}</span>
                ) : null;
              })}
            </div>
          </div>

          {/* lanes */}
          <div className="relative mt-1">
            {/* vertical hour gridlines spanning all lanes */}
            <div className="pointer-events-none absolute inset-0 left-[140px]">
              {ticks.map((t) => {
                const h = new Date(t).getHours();
                return <span key={t} className="absolute top-0 bottom-0 w-px" style={{ left: `${pos(t)}%`, background: h % 3 === 0 ? "var(--line)" : "var(--fill-1)" }} />;
              })}
              {/* now marker */}
              <span className="absolute top-0 bottom-0 w-px" style={{ left: "0%", background: toneMix("var(--accent)", 70) }} />
            </div>

            {s.jobs.map((j) => {
              const c = j.owner?.color ?? "var(--tone-neutral)";
              return (
                <button
                  key={j.base}
                  onClick={() => onOpenJob(j.base, c)}
                  title={`${j.base} · ${j.cadence.label}${j.owner ? ` · ${j.owner.name}` : ""} — open job`}
                  className="group flex w-full cursor-pointer items-center border-b border-line text-left transition-colors hover:bg-fill-1"
                >
                  <div className="flex w-[140px] shrink-0 items-center gap-1.5 py-2 pr-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />
                    <span className="truncate text-micro text-ink-dim group-hover:text-ink">{humanJobName(j.base)}</span>
                  </div>
                  <div className="relative h-8 flex-1">
                    {/* continuous / high-freq bands */}
                    {j.continuous && (
                      <div onMouseEnter={(e) => showTip(e, humanJobName(j.base), "always on")} onMouseLeave={hideTip}
                        className="absolute inset-y-2 left-0 right-0 rounded-md" style={{ background: toneMix(c, 16), border: `1px solid ${toneMix(c, 28)}` }}>
                        <span className="absolute inset-0 flex items-center justify-center font-mono text-micro" style={{ color: c }}>always-on</span>
                      </div>
                    )}
                    {j.highFreq && (
                      <div onMouseEnter={(e) => showTip(e, humanJobName(j.base), j.cadence.label)} onMouseLeave={hideTip}
                        className="absolute inset-y-2 left-0 right-0 rounded-md" style={{ backgroundImage: `repeating-linear-gradient(90deg, ${toneMix(c, 26)} 0 2px, transparent 2px 7px)`, border: `1px solid ${toneMix(c, 22)}` }}>
                        <span className="absolute inset-0 flex items-center justify-center font-mono text-micro" style={{ color: c }}>{j.cadence.label}</span>
                      </div>
                    )}
                    {j.eventDriven && (
                      <span onMouseEnter={(e) => showTip(e, humanJobName(j.base), "event-driven")} onMouseLeave={hideTip}
                        className="absolute left-1 top-1/2 -translate-y-1/2 font-mono text-micro text-ink-dim">on event</span>
                    )}
                    {/* discrete fire markers */}
                    {!j.highFreq && !j.continuous && j.fires.map((t, i) => (
                      <span
                        key={i}
                        onMouseEnter={(e) => showTip(e, humanJobName(j.base), clock(t))}
                        onMouseLeave={hideTip}
                        className="absolute top-1/2 z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform hover:scale-[1.7]"
                        style={{ left: `${pos(t)}%`, background: c, boxShadow: `0 0 7px ${c}` }}
                      />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>

          {/* floating hover name-tag */}
          {tip && (
            <div
              className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-line-strong bg-bg-3/95 px-2 py-1 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.9)]"
              style={{ left: tip.x, top: tip.y - 7 }}
            >
              <span className="font-mono text-micro text-ink">{tip.label}</span>
              {tip.sub && <span className="ml-1.5 font-mono text-micro text-ink-dim">{tip.sub}</span>}
              <span className="absolute left-1/2 top-full h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-line-strong bg-bg-3" />
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-micro text-ink-dim">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-ink-dim/50" /> fire</span>
            <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm" style={{ backgroundImage: "repeating-linear-gradient(90deg, var(--line-strong) 0 2px, transparent 2px 7px)" }} /> high-frequency</span>
            <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-fill-3" /> always-on</span>
            <span className="flex items-center gap-1"><span className="h-3 w-px bg-accent" /> now</span>
          </div>
        </div>
      )}
    </div>
  );
}
