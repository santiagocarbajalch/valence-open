"use client";

// CALIBRATED INSTRUMENT chrome — the navy sidebar (#10203F in BOTH themes).
// A flat rail: wordmark, six workflow items with monochrome glyphs, then a
// foot carrying the background-work pill, the theme toggle and the operator
// line. The rail only navigates; every action lives on the page it belongs to
// (doctrine: the rail classifies, the pane acts).
//
// Responsive (mockup breakpoints): full 216px rail >=1025; a 56px icon rail
// 761-1024 (labels become title tooltips); an off-canvas slide-over behind a
// slim top bar <=760. Layout lives in globals.css (.side / .topbar / …); this
// component wires the classes and the mobile open state.

import { useState, type ReactNode } from "react";

export type ShellView = "cockpit" | "pipeline" | "scraping" | "vault" | "chat" | "health";

const ICONS: Record<ShellView, ReactNode> = {
  cockpit: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" />
      <path d="M1.5 5.5h12M4.5 8.5h6" />
    </svg>
  ),
  pipeline: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="1.5" y="2" width="3.4" height="11" rx="1" />
      <rect x="5.8" y="2" width="3.4" height="7.5" rx="1" />
      <rect x="10.1" y="2" width="3.4" height="9.5" rx="1" />
    </svg>
  ),
  scraping: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M2 13l4-4m0 0l5.5-5.5a1.5 1.5 0 012 2L8 11l-3 1z" />
    </svg>
  ),
  vault: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <circle cx="7.5" cy="7.5" r="2" />
      <circle cx="2.8" cy="3" r="1.3" />
      <circle cx="12.4" cy="3.2" r="1.3" />
      <circle cx="3" cy="12" r="1.3" />
      <circle cx="12" cy="11.8" r="1.3" />
      <path d="M4 3.8l2.2 2.4M11.3 4.1L9 6M4 11.2l2.3-2.2M10.9 11l-2-1.9" />
    </svg>
  ),
  health: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <circle cx="7.5" cy="7.5" r="5.5" />
      <path d="M7.5 4.5v3l2 2" />
    </svg>
  ),
  chat: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M2 3.5h11v7H8l-3 2.5v-2.5H2z" />
    </svg>
  ),
};

// flat nav order (mockup): Today · Pipeline · Scraping · Vault · System · Valence
const NAV: { id: ShellView; name: string }[] = [
  { id: "cockpit", name: "Today" },
  { id: "pipeline", name: "Pipeline" },
  { id: "scraping", name: "Scraping" },
  { id: "vault", name: "Vault" },
  { id: "health", name: "System" },
  { id: "chat", name: "Valence" },
];

export function Sidebar({
  view,
  onNavigate,
  night,
  onToggleMode,
  workRunning,
  workFailed,
  onOpenWork,
}: {
  view: ShellView;
  onNavigate: (v: ShellView) => void;
  night: boolean;
  onToggleMode: () => void;
  workRunning: number;
  workFailed: number;
  onOpenWork: () => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const go = (v: ShellView) => { onNavigate(v); setMobileOpen(false); };

  const pillLabel =
    `Background work: ${workRunning} running${workFailed ? `, ${workFailed} failed` : ""}`;

  return (
    <>
      {/* slim mobile top bar (<=760) */}
      <header className="topbar">
        <button className="burger" aria-label="Open navigation" aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((o) => !o)}>&#9776;</button>
        <span className="mark">Valence</span>
      </header>
      <div className="side-backdrop" data-open={mobileOpen ? "true" : "false"}
        onClick={() => setMobileOpen(false)} />

      <nav className="side" aria-label="Console navigation" data-open={mobileOpen ? "true" : "false"}>
        {/* wordmark */}
        <div className="side-brand">
          <span className="badge" aria-hidden>V</span>
          <span>
            <span className="mark">Valence</span>
            <span className="micro" style={{ display: "block" }}>VELAB · sales console</span>
          </span>
        </div>

        {/* the six workflow views */}
        <div className="side-nav">
          {NAV.map((it) => (
            <button
              key={it.id}
              type="button"
              className="side-item"
              aria-label={it.name}
              title={it.name}
              aria-current={view === it.id ? "page" : undefined}
              onClick={() => go(it.id)}
            >
              <span className="glyph">{ICONS[it.id]}</span>
              <span className="label">{it.name}</span>
            </button>
          ))}
        </div>

        <div className="side-spacer" />

        {/* foot: work pill + theme toggle + operator line */}
        <div className="side-foot">
          <button type="button" className="work-pill" aria-label={pillLabel} onClick={onOpenWork}>
            <span aria-hidden>&#9881;</span>
            <span className="wp-label">
              {workRunning} running{workFailed ? <> · <span className="fail">{workFailed} failed</span></> : null}
            </span>
          </button>
          <button type="button" className="side-item" onClick={onToggleMode}
            aria-label={night ? "Switch to day" : "Switch to night"} title="Theme">
            <span className="glyph" aria-hidden>{night ? "☀" : "☾"}</span>
            <span className="label">{night ? "Switch to day" : "Switch to night"}</span>
          </button>
          <div className="side-op">Operator · sole operator</div>
        </div>
      </nav>
    </>
  );
}
