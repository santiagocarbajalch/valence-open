"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { attributeAgent, type ActivityKind } from "@/lib/activity";
import type { AgentId } from "@/lib/agents";
import { Hint, IconButton, Readout, SectionLabel, toast } from "@/components/kit";
import { pollJob } from "@/lib/pollJob";

interface SessionInfo { id: string; title: string; mtime: number; }
interface Cmd { name: string; description: string; kind: "command" | "skill"; }
interface Turn { role: "user" | "valence"; text: string; tools: string[] }

type Role = "user" | "valence";
interface Msg { id: number; role: Role; text: string; tools: string[]; streaming?: boolean; divider?: boolean }

// The three commands that matter daily — always shown, in plain language.
// Everything else in the registry is a generic skill, collapsed under ADVANCED.
const PRIMARY: Record<string, string> = {
  "draft": "Draft replies and outbound for today's work items.",
  "inbox-check": "Read the certified inbox board — who wrote, who's owed, what's due.",
  "stage-drafts": "Review, verify, and stage a pack into Gmail Drafts. Never sends.",
};

function ago(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

let _mid = 0;
const nextId = () => ++_mid;

export function ChatView({ onActivity }: { onActivity?: (agent: AgentId, kind: ActivityKind, text: string) => void }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [commands, setCommands] = useState<{ commands: Cmd[]; skills: Cmd[] }>({ commands: [], skills: [] });
  const [sessionId, setSessionId] = useState<string>("new");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [q, setQ] = useState("");
  const [titling, setTitling] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const loadSessions = useCallback(() => {
    fetch("/api/sessions").then((r) => r.json()).then((d) => setSessions(d.sessions ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    loadSessions();
    fetch("/api/commands").then((r) => r.json()).then(setCommands).catch(() => {});
  }, [loadSessions]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loadingHistory]);

  const send = useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setInput("");
    const userMsg: Msg = { id: nextId(), role: "user", text: prompt, tools: [] };
    const botId = nextId();
    setMessages((m) => [...m, userMsg, { id: botId, role: "valence", text: "", tools: [], streaming: true }]);
    onActivity?.("valence", "message", prompt.length > 70 ? prompt.slice(0, 70) + "…" : prompt);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, sessionId }),
      });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === "session" && typeof ev.sessionId === "string") {
            if (sessionId === "new") setSessionId(ev.sessionId);
          } else if (ev.type === "delta" && typeof ev.text === "string") {
            const t = ev.text as string;
            setMessages((m) => m.map((x) => x.id === botId ? { ...x, text: x.text + t } : x));
          } else if (ev.type === "tool" && typeof ev.name === "string") {
            const name = ev.name as string;
            setMessages((m) => m.map((x) => x.id === botId ? { ...x, tools: [...x.tools, name] } : x));
            const ag = attributeAgent(name, ev.input);
            const detail = typeof ev.input === "object" && ev.input
              ? (((ev.input as Record<string, unknown>).command as string) ||
                 ((ev.input as Record<string, unknown>).file_path as string) ||
                 ((ev.input as Record<string, unknown>).pattern as string) || "")
              : "";
            onActivity?.(ag, "tool", `${name}${detail ? ` · ${String(detail).slice(0, 60)}` : ""}`);
          } else if (ev.type === "error") {
            setMessages((m) => m.map((x) => x.id === botId ? { ...x, text: x.text + `\n\n⚠ ${ev.message}` } : x));
          }
        }
      }
    } catch (e) {
      setMessages((m) => m.map((x) => x.id === botId ? { ...x, text: x.text || `⚠ ${(e as Error).message}` } : x));
    } finally {
      setMessages((m) => m.map((x) => x.id === botId ? { ...x, streaming: false } : x));
      onActivity?.("valence", "done", "responded");
      setBusy(false);
      setTimeout(loadSessions, 1200);
      inputRef.current?.focus();
    }
  }, [busy, sessionId, loadSessions, onActivity]);

  // Resume = load the session's REAL history, then a slim divider (brief 2, #1).
  const openSession = async (id: string) => {
    setSessionId(id);
    setSidebarOpen(false);
    setLoadingHistory(true);
    setMessages([]);
    try {
      const d = await fetch(`/api/sessions?id=${encodeURIComponent(id)}`).then((r) => r.json()) as { turns?: Turn[] };
      const past: Msg[] = (d.turns ?? []).map((t) => ({ id: nextId(), role: t.role, text: t.text, tools: t.tools }));
      past.push({ id: nextId(), role: "valence", text: "", tools: [], divider: true });
      setMessages(past);
    } catch {
      setMessages([{ id: nextId(), role: "valence", text: "Could not load this session's history — you can still continue it.", tools: [] }]);
    } finally {
      setLoadingHistory(false);
      inputRef.current?.focus();
    }
  };
  const newSession = () => {
    setSessionId("new");
    setMessages([]);
    setSidebarOpen(false);
    setTimeout(loadSessions, 300);
    inputRef.current?.focus();
  };

  // One background pass to name sessions that don't have a title yet — opt-in
  // per click (doctrine tenet 25), never automatic.
  const titleChats = async () => {
    if (titling) return;
    setTitling(true);
    try {
      const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "title" }) });
      const d = await res.json() as { ok?: boolean; jobId?: string; count?: number; message?: string };
      if (!d.ok || !d.jobId) {
        toast(d.message ?? "Could not start titling.", { tone: "info" });
        setTitling(false);
        return;
      }
      toast(`Titling ${d.count ?? 0} session${d.count === 1 ? "" : "s"}…`, { tone: "info" });
      pollJob(d.jobId, (ok) => {
        setTitling(false);
        toast(ok ? "✓ Sessions titled" : "Titling stopped partway — try again", { tone: ok ? "ok" : "warn" });
        loadSessions();
      }, 3000);
    } catch {
      toast("Could not start titling.", { tone: "info" });
      setTitling(false);
    }
  };

  const insertCommand = (name: string) => {
    setInput((v) => (v ? v + ` /${name} ` : `/${name} `));
    setLauncherOpen(false);
    inputRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
  };

  const all = [...commands.commands, ...commands.skills].filter((c) => c.name?.trim());
  const primary = Object.keys(PRIMARY)
    .map((n) => all.find((c) => c.name === n) ?? { name: n, description: "", kind: "command" as const })
    .map((c) => ({ ...c, description: PRIMARY[c.name] }));
  const advanced = all.filter((c) => !(c.name in PRIMARY));
  const ql = q.trim().toLowerCase();
  const match = (c: Cmd) => (c.name + " " + c.description).toLowerCase().includes(ql);
  const shownPrimary = ql ? primary.filter(match) : primary;
  const shownAdvanced = ql ? advanced.filter(match) : advancedOpen ? advanced : [];

  const currentTitle = sessionId === "new" ? "New session" : (sessions.find((s) => s.id === sessionId)?.title ?? "Session");
  const dot = busy ? "var(--tone-warn)" : "var(--tone-ok)";

  const CmdRow = ({ c }: { c: Cmd }) => (
    <button onClick={() => insertCommand(c.name)} className="mb-1 block w-full rounded-ctl px-2.5 py-2 text-left transition-colors hover:bg-fill-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-caption text-ink">/{c.name}</span>
      </div>
      <div className="mt-0.5 text-caption leading-snug text-ink-dim">{c.description || "No description."}</div>
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between px-4">
        <span className="eyebrow flex items-center gap-1.5 tracking-[0.18em]">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot, boxShadow: `0 0 8px ${dot}` }} />
          {busy ? "VALENCE · THINKING…" : "VALENCE · READY"}
          <span className="ml-2 max-w-[320px] truncate normal-case tracking-normal text-ink-dim">{currentTitle}</span>
        </span>
        <div className="flex items-center gap-2">
          <button onClick={() => { setSidebarOpen((v) => !v); setLauncherOpen(false); }} aria-expanded={sidebarOpen}
            className="rounded-ctl px-2.5 py-1 text-caption text-ink-dim transition-colors hover:bg-fill-2 hover:text-ink">☰ SESSIONS</button>
          <button onClick={() => { setLauncherOpen((v) => !v); setSidebarOpen(false); }} aria-expanded={launcherOpen}
            className="rounded-ctl px-2.5 py-1 text-caption text-ink-dim transition-colors hover:bg-fill-2 hover:text-ink">⌘ COMMANDS</button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 px-3 pb-3">
        {/* conversation — full width; panels overlay it instead of squeezing it */}
        <section className="glass-strong relative flex h-full min-w-0 flex-col overflow-hidden rounded-pane">
          <div ref={scrollRef} className="thin-scroll flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            {messages.length === 0 && !loadingHistory && (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <span className="text-display text-accent" style={{ textShadow: "0 0 24px color-mix(in srgb, var(--accent) 40%, transparent)" }}>◇</span>
                <p className="mt-3 text-title text-ink">Valence — central command</p>
                <p className="mt-1 max-w-sm text-caption text-ink-dim">Ask anything, or run a slash command. Try: &ldquo;show me today&rsquo;s board — who do we owe?&rdquo;</p>
              </div>
            )}
            {loadingHistory && <p className="py-6 text-center text-caption text-ink-dim" role="status">LOADING THE CONVERSATION…</p>}
            <div className="mx-auto flex max-w-[760px] flex-col gap-4">
              {messages.map((m) => m.divider ? (
                <div key={m.id} className="flex items-center gap-3 py-1" role="separator">
                  <span className="h-px flex-1 bg-line" />
                  <span className="eyebrow text-ink-dim">RESUMED</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              ) : (
                <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div className={`max-w-[88%] rounded-card px-3.5 py-2.5 text-body ${
                    m.role === "user"
                      ? "bg-well text-ink"
                      : "border border-line border-l-2 border-l-accent/40 bg-bg-2 text-ink"
                  }`}>
                    {m.role === "valence" && (
                      <div className="mb-1 flex items-center gap-1.5 font-mono text-micro uppercase tracking-[0.16em] text-accent">
                        ◇ Valence
                      </div>
                    )}
                    {m.tools.length > 0 && (
                      <div className="mb-1.5 flex flex-wrap gap-1">
                        {m.tools.map((t, i) => (
                          <span key={i} className="rounded-full border border-line bg-well px-2 py-[1px] font-mono text-micro text-ink-dim">⚙ {t}</span>
                        ))}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap break-words">
                      {m.text}
                      {m.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-ink-dim/60" />}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* composer */}
          <div className="shrink-0 border-t border-line p-3">
            <div className="mx-auto flex max-w-[760px] items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                rows={1}
                placeholder="Message Valence…  (Enter to send, Shift+Enter for newline)"
                className="thin-scroll max-h-40 min-h-[42px] flex-1 resize-none rounded-card border border-line-strong bg-well px-3.5 py-2.5 text-body text-ink outline-none placeholder:text-ink-faint"
              />
              <button
                onClick={() => send(input)}
                disabled={busy || !input.trim()}
                className="h-[42px] shrink-0 rounded-card bg-accent px-4 text-body font-medium text-accent-contrast disabled:opacity-40"
              >
                {busy ? "…" : "Go"}
              </button>
              <Hint label="What running Valence does" className="mb-2.5">
                One agent run per message — under a minute, spends tokens. It never sends email.
              </Hint>
            </div>
          </div>
        </section>

        {/* SESSIONS — overlay, never squeezes the chat */}
        {sidebarOpen && (
          <aside className="glass-strong absolute bottom-3 left-3 top-0 z-20 flex w-72 flex-col rounded-pane p-2.5 shadow-2xl">
            <SectionLabel className="px-1" right={<IconButton label="Close sessions" onClick={() => setSidebarOpen(false)}>✕</IconButton>}>
              SESSIONS
            </SectionLabel>
            <button onClick={newSession} className="mb-2 w-full rounded-ctl border border-line bg-fill-2 px-3 py-2 text-left text-caption font-medium text-ink transition-colors hover:bg-fill-3">＋ NEW SESSION</button>
            <button onClick={titleChats} disabled={titling} className="mb-1 w-full rounded-ctl border border-line bg-fill-2 px-3 py-2 text-left text-caption font-medium text-ink transition-colors hover:bg-fill-3 disabled:opacity-50">
              {titling ? "TITLING…" : "✎ TITLE CHATS"}
            </button>
            <p className="mb-2 px-1 text-micro leading-snug text-ink-dim">Runs one short background pass to name sessions that don&rsquo;t have a title yet.</p>
            <div className="thin-scroll -mx-1 flex-1 overflow-y-auto px-1">
              {sessions.map((s) => (
                <button key={s.id} onClick={() => openSession(s.id)}
                  className={`mb-1 w-full rounded-ctl px-2.5 py-2 text-left transition-colors ${sessionId === s.id ? "bg-fill-3" : "hover:bg-fill-2"}`}>
                  <div className="truncate text-caption text-ink">{s.title}</div>
                  <Readout className="mt-0.5 block text-micro text-ink-dim">{ago(s.mtime)}</Readout>
                </button>
              ))}
              {sessions.length === 0 && <p className="px-2 py-4 text-center text-micro text-ink-dim">No sessions yet.</p>}
            </div>
          </aside>
        )}

        {/* COMMANDS — the 3 that matter, skills behind ADVANCED (brief 2, #3) */}
        {launcherOpen && (
          <aside className="glass-strong absolute bottom-3 right-3 top-0 z-20 flex w-80 flex-col rounded-pane p-3 shadow-2xl">
            <SectionLabel right={<IconButton label="Close commands" onClick={() => setLauncherOpen(false)}>✕</IconButton>}>
              COMMANDS
            </SectionLabel>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" aria-label="Filter commands"
              className="mb-2 w-full rounded-ctl border border-line-strong bg-well px-3 py-1.5 text-caption text-ink outline-none placeholder:text-ink-faint" />
            <div className="thin-scroll -mx-1 flex-1 overflow-y-auto px-1">
              {shownPrimary.map((c) => <CmdRow key={c.name} c={c} />)}
              {!ql && (
                <button onClick={() => setAdvancedOpen((v) => !v)} aria-expanded={advancedOpen}
                  className="eyebrow mb-1 mt-2 flex w-full items-center gap-1.5 px-2 text-ink-dim hover:text-ink">
                  <span aria-hidden>{advancedOpen ? "▾" : "▸"}</span> ADVANCED SKILLS ({advanced.length})
                </button>
              )}
              {shownAdvanced.map((c) => <CmdRow key={c.kind + c.name} c={c} />)}
              {ql && shownPrimary.length === 0 && shownAdvanced.length === 0 && (
                <p className="px-2 py-4 text-center text-micro text-ink-dim">No matches.</p>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
