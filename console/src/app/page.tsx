"use client";

import { useEffect, useState } from "react";
import { useSmoke } from "@/lib/status";
import { useActivity } from "@/lib/activity";
import { Sidebar, type ShellView } from "@/components/Sidebar";
import { WorkDrawer } from "@/components/WorkDrawer";
import { useTasks } from "@/lib/useTasks";
import { ChatView } from "@/components/ChatView";
import { HealthView } from "@/components/HealthView";
import { CockpitView } from "@/components/cockpit/CockpitView";
import { PipelineView } from "@/components/pipeline/PipelineView";
import { VaultView } from "@/components/VaultView";
import { ScrapingView } from "@/components/ScrapingView";

// FRONT OFFICE shell (2026-07-12, operator-approved redesign): the top tab
// bar is replaced by a navy sidebar grouped by workflow phase. The view set
// is unchanged from the same-day restructure: Today, Scraping, Vault (3D
// knowledge map + file navigator), Valence (chat), System. Internal view
// ids are unchanged.

export default function Console() {
  const { reports, running, ranAt, run } = useSmoke();
  const { events, push } = useActivity();
  const tasks = useTasks();
  const [view, setView] = useState<ShellView>("cockpit");
  // Pipeline → Today hand-off (ONE DESK port): "Open on Today" lands on the
  // cockpit with the company preselected; consumed once the board selects it.
  const [todayFocus, setTodayFocus] = useState<string | null>(null);
  // Task tray → Today hand-off: "Open send screen" on a staged-but-unsent pack
  // lands on the cockpit with that pack's guarded send confirm open.
  const [sendFocus, setSendFocus] = useState<string | null>(null);
  // day / night — class on <html>, persisted; layout.tsx applies it pre-paint.
  const [night, setNight] = useState(false);
  useEffect(() => { setNight(document.documentElement.classList.contains("night")); }, []);
  const toggleMode = () => {
    const next = !night;
    setNight(next);
    document.documentElement.classList.toggle("night", next);
    try { localStorage.setItem("valence-mode", next ? "night" : "day"); } catch { /* private mode */ }
  };

  // mount the chat lazily, then keep it alive across view switches
  const [chatMounted, setChatMounted] = useState(false);
  useEffect(() => {
    if (view === "chat") setChatMounted(true);
  }, [view]);

  // Vault tab — mounted lazily, kept alive so the 3D map's layout and the
  // folder tree survive view switches (re-simulating 3k nodes on every visit
  // would be waste).
  const [vaultMounted, setVaultMounted] = useState(false);
  useEffect(() => {
    if (view === "vault") setVaultMounted(true);
  }, [view]);

  return (
    <>
      {/* the chrome — the fixed navy rail; every view clears it via .app-main */}
      <Sidebar
        view={view} onNavigate={setView} night={night} onToggleMode={toggleMode}
        workRunning={tasks.running} workFailed={tasks.failed} onOpenWork={() => tasks.setOpen(true)}
      />

      <main className="app-main">
        {/* COCKPIT view — the daily operating loop (board → reply → cold → fresh → send) */}
        {view === "cockpit" && (
          <div className="h-full">
            <CockpitView focusKey={todayFocus} onFocusConsumed={() => setTodayFocus(null)}
              sendFile={sendFocus} onSendFileConsumed={() => setSendFocus(null)} />
          </div>
        )}

        {/* PIPELINE view — the whole field: every tracked company by state */}
        {view === "pipeline" && (
          <div className="h-full">
            <PipelineView onOpenToday={(key) => { setTodayFocus(key); setView("cockpit"); }} />
          </div>
        )}

        {/* SCRAPING view — the lead-sourcing dig */}
        {view === "scraping" && <div className="h-full"><ScrapingView /></div>}

        {/* VAULT view — the 3D knowledge map + the file navigator, one page */}
        {vaultMounted && (
          <div className={`h-full ${view === "vault" ? "block" : "hidden"}`}>
            <VaultView />
          </div>
        )}

        {/* CHAT view — mounted once, kept alive so the session persists; emits real activity */}
        {chatMounted && (
          <div className={`h-full ${view === "chat" ? "block" : "hidden"}`}>
            <ChatView onActivity={push} />
          </div>
        )}

        {/* SYSTEM view — health, scheduled jobs, org chart, activity & checks */}
        {view === "health" && (
          <div className="h-full">
            <HealthView events={events} smoke={{ reports, ranAt, running, run }} />
          </div>
        )}
      </main>

      {/* background work — a FIXED right overlay drawer (never a flex sibling);
          the pill that opens it lives in the sidebar foot */}
      <WorkDrawer
        tasks={tasks}
        onShowView={(v) => setView(v as ShellView)}
        onOpenSend={(file) => { setSendFocus(file); setView("cockpit"); }}
      />
    </>
  );
}
