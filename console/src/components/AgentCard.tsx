"use client";

import { useCallback, useEffect, useState } from "react";
import { IconButton, Overlay, OverlayTabs, StatusPill, toneMix, type Tone } from "@/components/kit";
import { humanJobName } from "@/lib/jobNames";

interface FileEntry { name: string; rel: string; full: string; mtime: number; size: number; }
interface Cron {
  name: string; desc: string; schedule: string; cadence: { label: string; approxSec: number };
  declared: boolean; owned: boolean;
  unit: string | null; state: string; last: number | null; next: number | null;
}
interface Dossier {
  meta: { id: string; name: string; color: string; glyph: string; tagline: string; purpose: string; realm: string };
  realmLive: boolean; realmRoot: string | null;
  crons: Cron[];
  files: { core: FileEntry[]; realm: FileEntry[]; realmTotal: number };
  activity: { ts: number; source: string; text: string }[];
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
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}
const STATE_TONE: Record<string, Tone> = { active: "ok", inactive: "dim", failed: "bad", absent: "dim" };

function CronStatePill({ state }: { state: string }) {
  return <StatusPill tone={STATE_TONE[state] ?? "dim"} label={state === "absent" ? "NOT BUILT YET" : state.toUpperCase()} />;
}

// ───────────────────────── editor ─────────────────────────
function FileEditor({ id, file, color }: { id: string; file: FileEntry; color: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setMsg(null); setContent(null);
    fetch(`/api/agent/file?id=${id}&path=${encodeURIComponent(file.full)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!alive) return; if (d.error) { setMsg({ kind: "err", text: d.error }); setLoading(false); return; } setContent(d.content); setOriginal(d.content); setLoading(false); })
      .catch(() => { if (alive) { setMsg({ kind: "err", text: "read failed" }); setLoading(false); } });
    return () => { alive = false; };
  }, [id, file.full]);

  const dirty = content !== null && content !== original;
  const save = useCallback(() => {
    if (content === null || saving) return;
    setSaving(true); setMsg(null);
    fetch("/api/agent/file", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, path: file.full, content }) })
      .then((r) => r.json())
      .then((d) => { if (d.error) setMsg({ kind: "err", text: d.error }); else { setOriginal(content); setMsg({ kind: "ok", text: "saved" }); } })
      .catch(() => setMsg({ kind: "err", text: "save failed" }))
      .finally(() => setSaving(false));
  }, [content, id, file.full, saving]);

  const realmData = !file.rel.endsWith(".md") && !/AGENT|CONTEXT|HEARTBEAT|\.prompt\./.test(file.rel);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-caption text-ink">{file.rel}</div>
          <div className="font-mono text-micro text-ink-dim">{(file.size / 1024).toFixed(1)} KB · {ago(file.mtime)}</div>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className={`font-mono text-micro ${msg.kind === "ok" ? "text-tone-ok-ink" : "text-tone-bad-ink"}`}>{msg.text}</span>}
          {dirty && <span className="font-mono text-micro text-ink-dim">unsaved</span>}
          <button
            onClick={save} disabled={!dirty || saving}
            className="rounded-ctl px-3.5 py-1.5 text-caption transition-colors disabled:opacity-40"
            style={{ border: `1px solid ${toneMix(color, 40)}`, color: dirty ? color : "var(--ink-faint)", background: dirty ? toneMix(color, 12) : "transparent" }}
          >
            {saving ? "saving…" : "save"}
          </button>
        </div>
      </div>
      {realmData && (
        <div className="mb-2 rounded-ctl border px-3 py-1.5 text-caption"
          style={{ borderColor: toneMix("var(--c-scraper)", 30), color: "var(--c-scraper)", background: toneMix("var(--c-scraper)", 8) }}>
          machine-generated realm data — edits may be overwritten on the next run
        </div>
      )}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-caption text-ink-dim">reading…</div>
      ) : content === null ? (
        <div className="flex flex-1 items-center justify-center text-caption text-tone-bad-ink">could not read file</div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } }}
          className="thin-scroll min-h-0 flex-1 resize-none rounded-card border border-line bg-well p-3.5 font-mono text-caption leading-[1.6] text-ink outline-none focus:border-line-strong"
        />
      )}
    </div>
  );
}

function FileBtn({ f, active, onClick, color }: { f: FileEntry; active: boolean; onClick: () => void; color: string }) {
  return (
    <button
      onClick={onClick} title={f.rel}
      className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-ctl px-2.5 py-1.5 text-left text-caption transition-colors ${active ? "text-ink" : "text-ink-dim hover:bg-fill-2 hover:text-ink"}`}
      style={active ? { background: toneMix(color, 16) } : undefined}
    >
      <span className="truncate font-mono">{f.rel}</span>
      <span className="shrink-0 font-mono text-micro text-ink-dim">{ago(f.mtime)}</span>
    </button>
  );
}

// ───────────────────────── tabs ─────────────────────────
function OverviewTab({ d }: { d: Dossier }) {
  return (
    <div className="thin-scroll h-full overflow-y-auto px-6 py-5">
      <section className="mb-6">
        <h4 className="eyebrow mb-2">jurisdiction & purpose</h4>
        {d.meta.tagline && <p className="mb-2.5 text-title text-ink">{d.meta.tagline}</p>}
        <p className="max-w-[68ch] text-body text-ink-dim">{d.meta.purpose || "No purpose statement found in AGENT.md."}</p>
      </section>

      <section>
        <h4 className="eyebrow mb-2.5">cron jobs · {d.crons.length}</h4>
        {d.crons.length === 0 ? (
          <p className="text-caption text-ink-dim">No units declared or owned.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {d.crons.map((c) => (
              <div key={c.name} className="rounded-card border border-line bg-fill-1 px-3.5 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-caption font-medium text-ink">{humanJobName(c.name)}</span>
                  <CronStatePill state={c.state} />
                </div>
                {c.desc && <p className="mt-1.5 text-caption leading-snug text-ink-dim">{c.desc}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {c.cadence?.label && c.cadence.label !== "not scheduled" && (
                    <span className="rounded-full border border-line px-1.5 py-[1px] font-mono text-micro text-ink-dim">{c.cadence.label}</span>
                  )}
                  <span className="flex flex-wrap gap-x-3 font-mono text-micro text-ink-dim">
                    {c.last != null && <span>last {ago(c.last)}</span>}
                    {c.next != null && <span>next {until(c.next)}</span>}
                    {!c.declared && c.owned && <span>live-mapped</span>}
                    {c.declared && c.state === "absent" && <span>Planned — not built yet</span>}
                  </span>
                </div>
                {c.schedule && c.schedule !== "—" && <div className="mt-1 truncate font-mono text-micro text-ink-dim" title={c.schedule}>{c.schedule}</div>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function FilesTab({ id, d, color }: { id: string; d: Dossier; color: string }) {
  const [sel, setSel] = useState<FileEntry | null>(d.files.core[0] ?? null);
  return (
    <div className="flex h-full min-h-0">
      <nav className="thin-scroll w-[250px] shrink-0 overflow-y-auto border-r border-line px-3 py-4">
        <div className="eyebrow mb-1 px-2.5">core files</div>
        {d.files.core.map((f) => <FileBtn key={f.full} f={f} active={sel?.full === f.full} onClick={() => setSel(f)} color={color} />)}
        <div className="eyebrow mt-4 mb-1 flex items-center justify-between px-2.5">
          <span>realm files</span>
          {d.files.realmTotal > d.files.realm.length && <span className="normal-case tracking-normal">{d.files.realm.length}/{d.files.realmTotal}</span>}
        </div>
        {d.files.realm.length === 0 ? (
          <div className="px-2.5 py-1 text-caption text-ink-dim">{d.realmLive ? "empty realm" : "realm not materialized"}</div>
        ) : d.files.realm.map((f) => <FileBtn key={f.full} f={f} active={sel?.full === f.full} onClick={() => setSel(f)} color={color} />)}
      </nav>
      <div className="min-w-0 flex-1 p-4">
        {sel ? <FileEditor id={id} file={sel} color={color} /> : <div className="flex h-full items-center justify-center text-caption text-ink-dim">select a file to view or edit</div>}
      </div>
    </div>
  );
}

function ActivityTab({ d }: { d: Dossier }) {
  return (
    <div className="thin-scroll h-full overflow-y-auto px-6 py-5">
      {d.activity.length === 0 ? (
        <p className="text-caption text-ink-dim">No recent activity recorded.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {d.activity.map((a, i) => (
            <li key={i} className="flex gap-3 border-b border-line pb-1.5 text-caption">
              <span className="w-[64px] shrink-0 font-mono text-micro text-ink-dim">{ago(a.ts)}</span>
              {a.source !== "file" && <span className="shrink-0 font-mono text-micro text-ink-dim">[{a.source.replace(/\.(service|timer)$/, "")}]</span>}
              <span className="min-w-0 flex-1 break-words text-ink-dim">{a.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────── card ─────────────────────────
type Tab = "overview" | "files" | "activity";

export function AgentCard({ id, color, onClose }: { id: string; color: string; onClose: () => void }) {
  const [d, setD] = useState<Dossier | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    let alive = true;
    fetch(`/api/agent?id=${id}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => { if (!alive) return; if (data.error) setErr(data.error); else setD(data); })
      .catch(() => alive && setErr("failed to load agent"));
    return () => { alive = false; };
  }, [id]);

  const c = d?.meta.color || color;
  // the raw file browser/editor is developer surface, not operator UI (brief 2, #12)
  const [advanced, setAdvanced] = useState(false);
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "activity", label: d ? `Activity · ${d.activity.length}` : "Activity" },
    ...(advanced ? [{ id: "files" as Tab, label: d ? `Files (advanced) · ${d.files.core.length + d.files.realm.length}` : "Files" }] : []),
  ];

  return (
    <Overlay onClose={onClose} accent={c} maxWidth={1040}>
      {/* header */}
      <div className="flex items-center gap-3.5 px-6 pt-5 pb-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card font-mono text-title font-medium"
          style={{ background: toneMix(c, 22), color: c, boxShadow: `inset 0 0 0 1px ${toneMix(c, 40)}` }}>
          {d?.meta.glyph ?? id[0].toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h2 className="text-title font-medium text-ink">{d?.meta.name ?? id}</h2>
            {d && <StatusPill tone={d.realmLive ? "ok" : "dim"} label={d.realmLive ? "LIVE" : "IN STAGING"} />}
          </div>
          {d?.meta.tagline && <p className="truncate text-caption text-ink-dim">{d.meta.tagline}</p>}
        </div>
        <button onClick={() => { setAdvanced((v) => { if (v && tab === "files") setTab("overview"); return !v; }); }}
          aria-pressed={advanced} className="eyebrow mr-2 shrink-0 rounded-ctl border border-line px-2 py-1 text-ink-dim hover:bg-fill-2 hover:text-ink">
          {advanced ? "▾" : "▸"} ADVANCED
        </button>
        <IconButton label="Close" onClick={onClose} className="text-title">✕</IconButton>
      </div>

      {/* tab bar */}
      {d && <OverlayTabs tabs={tabs} active={tab} onChange={setTab} accent={c} />}

      {/* body */}
      <div className="min-h-0 flex-1">
        {err ? (
          <div className="flex h-full items-center justify-center text-body text-ink-dim">{err}</div>
        ) : !d ? (
          <div className="flex h-full items-center justify-center text-body text-ink-dim">reading agent dossier…</div>
        ) : tab === "overview" ? <OverviewTab d={d} />
          : tab === "files" ? <FilesTab id={id} d={d} color={c} />
          : <ActivityTab d={d} />}
      </div>
    </Overlay>
  );
}
