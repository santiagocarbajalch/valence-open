"use client";

import { useState } from "react";
import { AGENTS } from "@/lib/agents";
import { toneMix } from "@/components/kit";
import { AgentCard } from "./AgentCard";

// The org chart — a Workspace view since 2026-07-02 (Team tab merged away;
// it restated the same six agents. Brief 2, §4E).

// planned-but-unbuilt agents (from the master plan roster). `node:true` means a
// node dir exists under VenusV2/os/agents/<id>, so the card can open for it.
// Colors here are IDENTITY data (like lib/agents.ts), not style.
const PLANNED = [
  { id: "bids", name: "Bids", role: "tenders / RFPs", color: "#c98a3a", node: true },
  { id: "service", name: "Service", role: "post-sale", color: "#5fb3c4", node: false },
  { id: "auditor", name: "Auditor", role: "data integrity", color: "#9aa6b8", node: false },
  { id: "sentinel", name: "Sentinel", role: "security", color: "#b0556a", node: false },
];

function glyphOf(name: string) { return name.trim()[0]?.toUpperCase() ?? "?"; }

function AgentNode({ name, role, color, built, central, onClick }: { name: string; role: string; color: string; built: boolean; central?: boolean; onClick?: () => void }) {
  const clickable = !!onClick;
  const w = central ? "w-[260px]" : "w-[210px]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`glass group relative flex ${w} flex-col items-center rounded-pane px-5 py-5 text-center transition-[transform,box-shadow,border-color] duration-200 ${clickable ? "cursor-pointer hover:-translate-y-1" : "cursor-default"}`}
      style={{ borderColor: `color-mix(in srgb, ${color} ${built ? 45 : 20}%, var(--glass-edge))`, opacity: built ? 1 : 0.55 }}
    >
      <span
        className="flex items-center justify-center rounded-full font-mono font-medium"
        style={{
          width: central ? 52 : 44, height: central ? 52 : 44, fontSize: central ? 20 : 17,
          color, background: toneMix(color, 18),
          boxShadow: built ? `inset 0 0 0 1px ${toneMix(color, 45)}, 0 0 18px -2px ${toneMix(color, 55)}` : `inset 0 0 0 1px ${toneMix(color, 25)}`,
        }}
      >
        {glyphOf(name)}
      </span>
      <div className={`mt-3 font-medium text-ink ${central ? "text-title" : "text-body"}`}>{name}</div>
      <div className="mt-0.5 text-caption text-ink-dim">{role}</div>
      {!built && <div className="mt-1.5 rounded-full border border-line px-2 py-[1px] font-mono text-micro uppercase tracking-wide text-ink-dim">NOT BUILT YET</div>}
      {clickable && <div className="eyebrow mt-2 opacity-0 transition-opacity group-hover:opacity-100">open ›</div>}
    </button>
  );
}

export function OrgChart() {
  const [card, setCard] = useState<{ id: string; color: string } | null>(null);
  const onOpen = (id: string, color: string) => setCard({ id, color });
  const valence = AGENTS.find((a) => a.central)!;
  const workers = AGENTS.filter((a) => !a.central);
  return (
    <div className="thin-scroll h-full overflow-y-auto py-10">
      <div className="mx-auto flex w-fit min-w-full max-w-[1200px] flex-col items-center px-8">
        {/* command */}
        <AgentNode name={valence.name} role={valence.role} color={valence.color} built central onClick={() => onOpen(valence.id, valence.color)} />
        <div className="h-8 w-px bg-line-strong" />
        <div className="eyebrow tracking-[0.2em]">ORDERS FLOW DOWN · TRUTH FLOWS UP</div>
        <div className="h-8 w-px bg-line-strong" />

        {/* built workers */}
        <div className="flex flex-wrap items-stretch justify-center gap-5">
          {workers.map((a) => (
            <AgentNode key={a.id} name={a.name} role={a.role} color={a.color} built onClick={() => onOpen(a.id, a.color)} />
          ))}
        </div>

        {/* planned */}
        <div className="mt-12 mb-4 flex items-center gap-3">
          <span className="h-px w-12 bg-line" />
          <span className="eyebrow tracking-[0.2em]">PLANNED ROSTER — COMING SOON</span>
          <span className="h-px w-12 bg-line" />
        </div>
        <div className="flex flex-wrap items-stretch justify-center gap-5">
          {PLANNED.map((a) => (
            <AgentNode key={a.id} name={a.name} role={a.role} color={a.color} built={false} onClick={a.node ? () => onOpen(a.id, a.color) : undefined} />
          ))}
        </div>
      </div>
      {card && <AgentCard id={card.id} color={card.color} onClose={() => setCard(null)} />}
    </div>
  );
}
