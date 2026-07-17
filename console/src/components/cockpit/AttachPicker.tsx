"use client";

import { useEffect, useState } from "react";
import { Modal, Action } from "@/components/kit";

// Browse the asset library (PDF catalogs, the price list, per-model fichas) and
// write the chosen relative paths into a draft pack entry's `attachments[]`. This
// is the operator's "verify the attachment" surface — selection is manual on
// purpose (there is no auto ficha→product match), so the right datasheet is a
// deliberate human choice, made visible.
//
// Two modes: with `file` the choice is saved into the pack entry; with `onPick`
// (and no file) it is handed back to the caller — the pre-draft flow, where the
// picks ride the next "Draft the reply" run and land on the pack it writes.

interface Asset { name: string; path: string; group: string; kind: string; size: number }
const KIND_LABEL: Record<string, string> = { catalog: "Catálogo", ficha: "Ficha técnica", pricelist: "Lista de precios", image: "Imagen", file: "Archivo" };

function human(n: number) {
  if (n > 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n > 1e3) return `${Math.round(n / 1e3)}KB`;
  return `${n}B`;
}

export function AttachPicker({
  file,
  entryIndex,
  current,
  onClose,
  onSaved,
  onPick,
}: {
  file?: string | null; // pack file name — omit for pick-mode
  entryIndex?: number; // which draft entry in the pack
  current: string[]; // currently attached/picked paths
  onClose: () => void;
  onSaved?: (paths: string[]) => void;
  onPick?: (paths: string[]) => void; // pick-mode: hand the selection back, no pack write
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set(current));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/assets").then((r) => r.json()).then((d) => setAssets(d.files ?? [])).catch(() => {});
  }, []);

  const toggle = (p: string) => setSel((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  const save = async () => {
    if (!file) { onPick?.([...sel]); onClose(); return; }
    setSaving(true);
    setErr(null);
    try {
      // read the pack, set attachments on the chosen entry, write it back
      const pr = await fetch(`/api/draft/file?file=${encodeURIComponent(file)}`).then((r) => r.json());
      if (!pr.content) throw new Error("could not read pack");
      const pack = JSON.parse(pr.content);
      const lists = Object.keys(pack).filter((k) => Array.isArray(pack[k]));
      // find the entry by global index across list-valued keys
      let i = entryIndex ?? 0;
      let done = false;
      for (const k of lists) {
        if (i < pack[k].length) { pack[k][i].attachments = [...sel]; done = true; break; }
        i -= pack[k].length;
      }
      if (!done) throw new Error("entry not found");
      const res = await fetch("/api/draft/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, content: JSON.stringify(pack, null, 2) }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "save failed");
      onSaved?.([...sel]);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const groups = Array.from(new Set(assets.map((a) => a.group)));
  const dirty = sel.size !== current.length || [...sel].some((p) => !current.includes(p));

  return (
    <Modal title={<>Attach files <span className="text-ink-faint">· {sel.size} selected</span></>} onClose={onClose} wide dirty={dirty}
      footer={<>
        <Action variant="neutral" onClick={onClose}>Cancel</Action>
        <button onClick={save} disabled={saving} className="rounded-lg px-3.5 py-1.5 text-caption font-medium text-ink-on-vivid disabled:opacity-40" style={{ background: "var(--c-valence)" }}>{saving ? "saving…" : file ? "Save to the draft" : "Attach when it drafts"}</button>
      </>}>
      <div className="pr-1">
        {groups.map((g) => (
            <div key={g} className="mb-3">
              <div className="mb-1.5 text-caption font-medium text-ink-dim">{g === "." ? "General" : g}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {assets.filter((a) => a.group === g).map((a) => {
                  const on = sel.has(a.path);
                  return (
                    <button key={a.path} onClick={() => toggle(a.path)} aria-pressed={on}
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${on ? "border-white/30 bg-white/10" : "border-white/8 bg-white/[0.02] hover:bg-white/5"}`}>
                      <span className={`grid h-4 w-4 shrink-0 place-items-center rounded text-micro ${on ? "bg-[var(--c-valence)] text-ink-on-vivid" : "border border-line-strong"}`}>{on ? "✓" : ""}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-caption text-ink">{a.name}</span>
                        <span className="block text-micro text-ink-dim">{KIND_LABEL[a.kind] ?? a.kind} · {human(a.size)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {assets.length === 0 && <p className="py-8 text-center text-caption text-ink-dim">loading library…</p>}
        </div>
        {err && <p className="mt-2 text-micro text-tone-bad-ink">⚠ {err}</p>}
    </Modal>
  );
}
