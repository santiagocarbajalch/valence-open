"use client";

import { useCallback, useEffect, useState } from "react";
import { Action, ErrorState, Modal, Skeleton, TypeTag, cx } from "@/components/kit";

// Fresh outreach picker — pull verified leads into today's pipeline.
interface Lead { institution: string; email: string; contactName: string; phone: string; country: string; geo: string; clientType: string; reachable: string | null }

export function FreshModal({ onClose, onPicked }: { onClose: () => void; onPicked: (emails: string[]) => void }) {
  const [data, setData] = useState<{ total: number; contactedHidden: number; facets: { geos: string[]; types: string[] }; leads: Lead[] } | null>(null);
  const [err, setErr] = useState(false);
  const [geo, setGeo] = useState(""); const [type, setType] = useState(""); const [qStr, setQStr] = useState("");
  const [selEmails, setSelEmails] = useState<Set<string>>(new Set());
  const CAP = 50;
  const load = useCallback(() => {
    setErr(false);
    const q = new URLSearchParams(); if (geo) q.set("geo", geo); if (type) q.set("type", type);
    fetch(`/api/leads?${q}`).then((r) => r.ok ? r.json() : Promise.reject()).then(setData).catch(() => setErr(true));
  }, [geo, type]);
  useEffect(load, [load]);
  const visible = (data?.leads ?? []).filter((l) => !qStr || (l.institution + " " + l.email).toLowerCase().includes(qStr.toLowerCase()));
  const toggle = (e: string) => setSelEmails((s) => { const n = new Set(s); if (n.has(e)) n.delete(e); else if (n.size < CAP) n.add(e); return n; });
  const selectAll = () => setSelEmails((s) => { const n = new Set(s); for (const l of visible) { if (n.size >= CAP) break; n.add(l.email); } return n; });

  return (
    <Modal title="Fresh outreach — pull verified leads into today's pipeline" wide onClose={onClose}
      footer={<>
        <Action onClick={onClose}>Cancel</Action>
        <button disabled={selEmails.size === 0} onClick={() => onPicked([...selEmails])} className="rounded-ctl bg-accent px-4 py-1.5 text-body font-medium text-accent-contrast disabled:opacity-40">
          Add {selEmails.size} to the day
        </button>
      </>}>
      {err && <ErrorState what="verified leads" onRetry={load} />}
      {!err && !data && <Skeleton rows={5} />}
      {data && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-body">
            <select aria-label="Filter by geography" value={geo} onChange={(e) => setGeo(e.target.value)} className="rounded-ctl border border-line bg-well px-2 py-1 text-ink"><option value="">All geos</option>{data.facets.geos.map((g) => <option key={g} value={g}>{g}</option>)}</select>
            <select aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)} className="rounded-ctl border border-line bg-well px-2 py-1 text-ink"><option value="">All types</option>{data.facets.types.map((t) => <option key={t} value={t}>{t}</option>)}</select>
            <input aria-label="Filter leads by name or email" value={qStr} onChange={(e) => setQStr(e.target.value)} placeholder="Filter…" className="w-32 rounded-ctl border border-line bg-well px-2 py-1 text-ink placeholder:text-ink-faint outline-none focus:border-line-strong" />
            <Action onClick={selectAll}>Select {Math.min(visible.length, CAP - selEmails.size)} visible</Action>
            <span className={cx("font-mono", selEmails.size >= CAP ? "text-tone-warn-ink" : "text-ink-faint")}>{selEmails.size}/{CAP}</span>
            <span className="text-ink-faint">· {data.total} available · {data.contactedHidden} already-contacted hidden</span>
          </div>
          <div className="flex flex-col">
            {visible.map((l) => {
              const on = selEmails.has(l.email); const blocked = !on && selEmails.size >= CAP;
              return (
                <button key={l.email} onClick={() => toggle(l.email)} disabled={blocked} aria-pressed={on}
                  className={cx("flex w-full items-center gap-2 rounded-ctl px-3 py-1.5 text-left text-body transition-colors", on ? "bg-fill-3" : "hover:bg-fill-2", blocked && "opacity-30")}>
                  <span className={cx("grid h-4 w-4 shrink-0 place-items-center rounded text-caption", on ? "bg-accent text-accent-contrast" : "border border-line-strong")}>{on ? "✓" : ""}</span>
                  <span className="min-w-0 flex-1 truncate text-ink">{l.institution} <span className="text-ink-faint">· {l.email}</span></span>
                  <TypeTag>{l.country}</TypeTag>
                </button>
              );
            })}
            {visible.length === 0 && <p className="px-3 py-4 text-center text-body text-ink-dim">No leads match.</p>}
          </div>
        </>
      )}
    </Modal>
  );
}
