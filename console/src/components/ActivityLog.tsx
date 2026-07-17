"use client";

import { AGENT_BY_ID } from "@/lib/agents";
import type { ActivityEvent } from "@/lib/activity";
import { toneMix } from "@/components/kit";

const KIND_GLYPH = { session: "◇", tool: "⚙", message: "›", done: "✓" } as const;

function time(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function ActivityLog({ events }: { events: ActivityEvent[] }) {
  return (
    <section id="activity" className="relative w-full px-5 pt-6 sm:px-8">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-body font-medium tracking-tight text-ink">Activity log</h2>
          <span className="eyebrow">real actions · driven by the chat</span>
        </div>

        <div className="glass thin-scroll max-h-[34vh] overflow-y-auto rounded-pane p-4">
          {events.length === 0 ? (
            <p className="py-6 text-center font-mono text-caption text-ink-dim">
              no activity yet — talk to Valence in the chat and its actions land here
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {events.slice().reverse().map((e) => {
                const a = AGENT_BY_ID[e.agent];
                return (
                  <li key={e.id} className="flex items-start gap-3">
                    <span className="mt-[2px] shrink-0 font-mono text-micro tabular-nums text-ink-dim">{time(e.ts)}</span>
                    <span
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-[1px] text-caption font-medium"
                      style={{ color: a.color, background: toneMix(a.color, 12), borderColor: toneMix(a.color, 24) }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: a.color }} />
                      {a.name}
                    </span>
                    <span className="min-w-0 text-caption text-ink-dim">
                      <span className="mr-1.5 text-ink-faint">{KIND_GLYPH[e.kind]}</span>
                      {e.text}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
