"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton, Overlay, OverlayTabs, StatusPill, type Tone } from "@/components/kit";
import { humanJobName } from "@/lib/jobNames";

interface Detail {
  base: string; unit: string; kind: "timer" | "service"; triggers: string | null;
  description: string; schedule: string[]; cadence: { label: string; approxSec: number };
  persistent: boolean; state: string; last: number | null; next: number | null;
  owner: { id: string; name: string; color: string } | null; system: boolean;
  files: { unit: string; path: string; content: string }[];
  logs: { ts: number; source: string; text: string }[];
}

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
  return new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
const STATE_TONE: Record<string, Tone> = { active: "ok", inactive: "dim", failed: "bad", unknown: "dim" };

// ── edit-with-agent: a compact one-task Valence chat scoped to this unit ──
type Msg = { id: number; role: "user" | "valence"; text: string; tools: string[]; streaming?: boolean };
let _mid = 0;

function EditWithAgent({ d, color }: { d: Detail; color: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<string>("new");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs]);

  const context = useCallback(() => {
    const files = d.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    return [
      `You are editing a systemd scheduled job on this server (Tailnet-only operator console).`,
      `Job: ${d.base} (${d.kind})${d.owner ? ` · owned by the ${d.owner.name} agent` : " · system"}`,
      `Current schedule (OnCalendar): ${d.schedule.join(" ; ") || "—"}  [${d.cadence.label}]`,
      d.triggers ? `Timer triggers: ${d.triggers}` : "",
      ``,
      `Unit file(s):`,
      files,
      ``,
      `When the operator asks for a change: edit the unit file(s) at the path(s) above, then run \`systemctl daemon-reload\` and restart/re-enable the timer as needed. Verify with \`systemctl list-timers ${d.base}.timer\` (or \`systemctl status\`) and report the new schedule. Never send email.`,
    ].filter(Boolean).join("\n");
  }, [d]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true); setInput("");
    const uid = ++_mid, bid = ++_mid;
    setMsgs((m) => [...m, { id: uid, role: "user", text, tools: [] }, { id: bid, role: "valence", text: "", tools: [], streaming: true }]);
    // prepend the unit context only on the first turn of this session
    const prompt = sessionRef.current === "new" ? `${context()}\n\nOperator request: ${text}` : text;
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, sessionId: sessionRef.current }) });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim(); if (!line.startsWith("data:")) continue;
          let ev: Record<string, unknown>; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === "session" && typeof ev.sessionId === "string") { if (sessionRef.current === "new") sessionRef.current = ev.sessionId; }
          else if (ev.type === "delta" && typeof ev.text === "string") { const t = ev.text as string; setMsgs((m) => m.map((x) => x.id === bid ? { ...x, text: x.text + t } : x)); }
          else if (ev.type === "tool" && typeof ev.name === "string") { const n = ev.name as string; setMsgs((m) => m.map((x) => x.id === bid ? { ...x, tools: [...x.tools, n] } : x)); }
          else if (ev.type === "error") { setMsgs((m) => m.map((x) => x.id === bid ? { ...x, text: x.text + `\n\n⚠ ${ev.message}` } : x)); }
        }
      }
    } catch (e) {
      setMsgs((m) => m.map((x) => x.id === bid ? { ...x, text: x.text || `⚠ ${(e as Error).message}` } : x));
    } finally {
      setMsgs((m) => m.map((x) => x.id === bid ? { ...x, streaming: false } : x));
      setBusy(false);
    }
  }, [input, busy, context]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 rounded-ctl border border-line bg-fill-1 px-3 py-2 text-caption text-ink-dim">
        Ask Valence to change this job — e.g. <span className="text-ink">&ldquo;run it every 2 hours instead&rdquo;</span> or <span className="text-ink">&ldquo;move the daily run to 07:00 America/Chicago&rdquo;</span>. It edits the unit file, reloads systemd, and verifies. The unit&rsquo;s files + schedule are attached automatically.
      </div>
      <div ref={scrollRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto rounded-card border border-line bg-well p-3">
        {msgs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-caption text-ink-dim">no changes requested yet</div>
        ) : (
          <div className="flex flex-col gap-3">
            {msgs.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[88%] rounded-2xl px-3 py-2 text-body ${m.role === "user" ? "bg-fill-3 text-ink" : "border border-line bg-fill-1 text-ink-dim"}`}>
                  {m.tools.length > 0 && (
                    <div className="mb-1.5 flex flex-wrap gap-1">
                      {m.tools.map((t, i) => <span key={i} className="rounded-full border border-line bg-well px-2 py-[1px] font-mono text-micro text-ink-dim">⚙ {t}</span>)}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-words">{m.text}{m.streaming && <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-ink-dim/60" />}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mt-2 flex items-end gap-2">
        <textarea
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={1} placeholder="Describe the change…  (Enter to send)"
          className="thin-scroll max-h-32 min-h-[40px] flex-1 resize-none rounded-card border border-line bg-well px-3 py-2 text-body text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
        />
        <button onClick={send} disabled={busy || !input.trim()} className="h-[40px] shrink-0 rounded-card px-4 text-body font-medium text-bg-0 disabled:opacity-40" style={{ background: color }}>{busy ? "…" : "Send"}</button>
      </div>
    </div>
  );
}

// ── tabs ──
function TimingTab({ d }: { d: Detail }) {
  return (
    <div className="thin-scroll h-full overflow-y-auto px-6 py-5">
      {d.description && <p className="mb-5 max-w-[70ch] text-body text-ink-dim">{d.description}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-card border border-line bg-fill-1 p-4">
          <div className="eyebrow">cadence</div>
          <div className="mt-1 text-title text-ink">{d.cadence.label}</div>
        </div>
        <div className="rounded-card border border-line bg-fill-1 p-4">
          <div className="eyebrow">state</div>
          <div className="mt-1 text-title text-ink">{d.state}{d.persistent ? " · persistent" : ""}</div>
        </div>
        <div className="rounded-card border border-line bg-fill-1 p-4">
          <div className="eyebrow">last fired</div>
          <div className="mt-1 text-body text-ink">{ago(d.last)}</div>
          <div className="mt-0.5 font-mono text-micro text-ink-dim">{abs(d.last)}</div>
        </div>
        <div className="rounded-card border border-line bg-fill-1 p-4">
          <div className="eyebrow">next fire</div>
          <div className="mt-1 text-body text-ink">{until(d.next)}</div>
          <div className="mt-0.5 font-mono text-micro text-ink-dim">{abs(d.next)}</div>
        </div>
      </div>
      {/* raw systemd calendar strings live under ADVANCED · Unit file, not here */}
    </div>
  );
}

function LogsTab({ d }: { d: Detail }) {
  return (
    <div className="thin-scroll h-full overflow-y-auto px-6 py-5">
      {d.logs.length === 0 ? <p className="text-caption text-ink-dim">no journal entries</p> : (
        <ul className="flex flex-col gap-0.5 font-mono text-caption">
          {d.logs.map((l, i) => (
            <li key={i} className="flex gap-3 border-b border-line py-1">
              <span className="w-[120px] shrink-0 text-ink-faint">{abs(l.ts)}</span>
              <span className="shrink-0 text-ink-faint/70">{l.source.replace(/\.(service|timer)$/, "").endsWith("timer") ? "T" : l.source.endsWith(".timer") ? "T" : "S"}</span>
              <span className="min-w-0 flex-1 break-words text-ink-dim">{l.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilesTab({ d }: { d: Detail }) {
  return (
    <div className="thin-scroll h-full overflow-y-auto px-6 py-5">
      {d.files.length === 0 ? <p className="text-caption text-ink-dim">no unit files found</p> : d.files.map((f) => (
        <div key={f.path} className="mb-4">
          <div className="mb-1 font-mono text-caption text-ink-dim">{f.path}</div>
          <pre className="thin-scroll overflow-x-auto rounded-card border border-line bg-well p-3.5 font-mono text-caption leading-[1.6] text-ink-dim">{f.content}</pre>
        </div>
      ))}
      <p className="mt-1 text-caption text-ink-dim">Unit files are shown read-only here — use “Edit with agent” to change them safely (edit + daemon-reload + verify).</p>
    </div>
  );
}

type Tab = "timing" | "logs" | "files" | "edit";

export function CronDetail({ unit, color, onClose }: { unit: string; color: string; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("timing");

  useEffect(() => {
    let alive = true;
    fetch(`/api/cron?unit=${encodeURIComponent(unit)}`, { cache: "no-store" })
      .then((r) => r.json()).then((data) => { if (!alive) return; if (data.error) setErr(data.error); else setD(data); })
      .catch(() => alive && setErr("failed to load job"));
    return () => { alive = false; };
  }, [unit]);

  const c = d?.owner?.color || color;
  // systemd internals + agent editing sit behind ADVANCED (brief 2, #9)
  const [advanced, setAdvanced] = useState(false);
  const tabs: { id: Tab; label: string }[] = [
    { id: "timing", label: "Schedule & timing" },
    { id: "logs", label: d ? `Logs · ${d.logs.length}` : "Logs" },
    ...(advanced ? [
      { id: "files" as Tab, label: "Unit file (systemd)" },
      { id: "edit" as Tab, label: "✦ Edit with agent" },
    ] : []),
  ];

  return (
    <Overlay onClose={onClose} accent={c} maxWidth={940}>
      <div className="flex items-center gap-3 px-6 pt-5 pb-4">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c, boxShadow: `0 0 8px ${c}` }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h2 className="text-title font-medium text-ink">{humanJobName(d?.base ?? unit.replace(/\.(timer|service)$/, ""))}</h2>
            {d && <StatusPill tone={STATE_TONE[d.state] ?? "dim"} label={d.state} />}
          </div>
          {d && <p className="truncate text-caption text-ink-dim">{d.owner ? `${d.owner.name} · ` : "System · "}{d.cadence.label}</p>}
        </div>
        <button onClick={() => { setAdvanced((v) => { if (v && (tab === "files" || tab === "edit")) setTab("timing"); return !v; }); }}
          aria-pressed={advanced} className="eyebrow mr-2 shrink-0 rounded-ctl border border-line px-2 py-1 text-ink-dim hover:bg-fill-2 hover:text-ink">
          {advanced ? "▾" : "▸"} ADVANCED
        </button>
        <IconButton label="Close" onClick={onClose} className="text-title">✕</IconButton>
      </div>

      {d && <OverlayTabs tabs={tabs} active={tab} onChange={setTab} accent={c} />}

      <div className="min-h-0 flex-1">
        {err ? <div className="flex h-full items-center justify-center text-body text-ink-dim">{err}</div>
          : !d ? <div className="flex h-full items-center justify-center text-body text-ink-dim">reading job…</div>
          : tab === "timing" ? <TimingTab d={d} />
          : tab === "logs" ? <LogsTab d={d} />
          : tab === "files" ? <FilesTab d={d} />
          : <div className="h-full px-6 py-5"><EditWithAgent d={d} color={c} /></div>}
      </div>
    </Overlay>
  );
}
