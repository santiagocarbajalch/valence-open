"use client";

import { AGENT_BY_ID } from "@/lib/agents";
import type { AgentReport } from "@/lib/status";
import { Dot, type Tone } from "@/components/kit";

// smoke levels → kit tones ("fail" is the board's word for the bad tone)
const LEVEL_TONE: Record<"ok" | "warn" | "fail", Tone> = { ok: "ok", warn: "warn", fail: "bad" };
const LEVEL_INK: Record<"ok" | "warn" | "fail", string> = {
  ok: "var(--tone-ok-ink)", warn: "var(--tone-warn-ink)", fail: "var(--tone-bad-ink)",
};

export function SmokeReport({
  reports,
  ranAt,
  running,
  onRun,
}: {
  reports: Record<string, AgentReport>;
  ranAt: number | null;
  running: boolean;
  onRun: () => void;
}) {
  const list = Object.values(reports);
  const archivist = reports["archivist"];

  return (
    <section id="report" className="relative w-full px-5 pb-12 pt-6 sm:px-8">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="text-body font-medium tracking-tight text-ink">System smoke test</h2>
            <span className="eyebrow">
              {ranAt ? `ran ${new Date(ranAt).toLocaleTimeString()}` : "each agent verifies its real processes"}
            </span>
          </div>
          <button
            onClick={onRun}
            disabled={running}
            className="rounded-ctl border border-line-strong bg-fill-2 px-3.5 py-1.5 text-caption text-ink transition-colors hover:bg-fill-3 disabled:opacity-50"
          >
            {running ? "running…" : ranAt ? "↻ re-run" : "▸ Run smoke test"}
          </button>
        </div>

        {list.length === 0 && (
          <div className="glass rounded-pane p-8 text-center">
            <p className="text-body text-ink-dim">Run the smoke test to verify every agent against its live data.</p>
            <p className="mt-1 font-mono text-micro text-ink-dim">
              reads the real vault — inbox picture, lead inventory, send-auth gate, CRM, job health.
            </p>
          </div>
        )}

        {/* the inbox-today headline — what Valence surfaces from the Archivist */}
        {archivist && archivist.headline.length > 0 && (
          <div className="glass-strong mb-4 rounded-pane p-5">
            <div className="mb-3 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: AGENT_BY_ID.archivist.color, boxShadow: `0 0 8px ${AGENT_BY_ID.archivist.color}` }} />
              <span className="text-caption font-medium text-ink">The inbox today</span>
              <span className="font-mono text-micro text-ink-dim">· via the Archivist</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
              {archivist.headline.map((h) => (
                <div key={h.label} className="rounded-card border border-line bg-fill-1 p-3">
                  <div className="font-mono text-display leading-none text-ink">{h.value}</div>
                  <div className="mt-1.5 text-micro uppercase tracking-wide text-ink-dim">{h.label}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-caption text-ink-dim">{archivist.summary}</p>
          </div>
        )}

        {/* per-agent check cards */}
        {list.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {list.map((r) => {
              const a = AGENT_BY_ID[r.agent];
              return (
                <div key={r.agent} className="glass rounded-pane p-4" style={{ borderColor: `color-mix(in srgb, ${a.color} 35%, var(--glass-edge))` }}>
                  <div className="mb-2.5 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: a.color, boxShadow: `0 0 8px ${a.color}` }} />
                      <span className="text-body font-medium text-ink">{a.name}</span>
                    </div>
                    <span className="flex items-center gap-1.5 font-mono text-micro uppercase tracking-wide" style={{ color: LEVEL_INK[r.status] }}>
                      <Dot tone={LEVEL_TONE[r.status]} title={r.status} /> {r.status}
                    </span>
                  </div>
                  <ul className="flex flex-col gap-1.5">
                    {r.checks.map((c, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="mt-[5px]"><Dot tone={LEVEL_TONE[c.level]} title={c.level} /></span>
                        <span className="min-w-0">
                          <span className="text-caption text-ink-dim">{c.label}</span>
                          <span className="ml-1.5 font-mono text-micro text-ink-dim">{c.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
