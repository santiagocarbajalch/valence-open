"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Action, Skeleton, ErrorState, toast, cx } from "@/components/kit";

// House Format — the single surface for the VELAB outbound look. Edits write
// vault/pipeline/house-format.json, which BOTH the sender (send_batch.house_html)
// and the stager (stage_drafts_in_gmail.houseHtml) read. The operator gets
// STYLED CONTROLS (font, size, color, spacing) — never raw CSS (brief, dir. 18);
// the raw strings remain reachable under ADVANCED for exotic cases. The right
// pane is a live preview using the SAME generation algorithm the tools use.

interface SigLine { text: string; style: string }
interface HF {
  _note?: string;
  body: { div_style: string; paragraph_style: string };
  signature: { strip_lines: string[]; lines: SigLine[] };
  defaults: { cc: string; attach: string };
}
interface Asset { name: string; path: string; group: string }

// A representative body — mirrors house_format_preview.py's SAMPLE so the client
// preview matches the server render.
const SAMPLE = [
  "Estimado equipo de Acme Labs,",
  "",
  "Mi nombre es Robert Montalvo, de VELAB, fabricante estadounidense de equipos de laboratorio.",
  "",
  "Me gustaría explorar una alianza de distribución con ustedes para el mercado local.",
  "",
  "Quedo atento a sus comentarios.",
].join("\n");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// EXACT mirror of the tools' houseHtml algorithm, for instant WYSIWYG while editing.
function renderHouse(hf: HF): string {
  const strip = new Set(hf.signature.strip_lines);
  const core = SAMPLE.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((l) => !strip.has(l) && !/^_{3,}$/.test(l));
  const out = [`<div style='${hf.body.div_style}'>`];
  for (const p of core) out.push(`  <p style='${hf.body.paragraph_style}'>${esc(p)}</p>`);
  for (const l of hf.signature.lines) out.push(`  <p style='${l.style}'>${l.text}</p>`);
  out.push("</div>");
  return out.join("\n");
}

// ── tiny CSS-string helpers: read/write single properties, keep the rest ────
function getProp(style: string, prop: string): string | null {
  let v: string | null = null;
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    if (part.slice(0, i).trim().toLowerCase() === prop) v = part.slice(i + 1).trim();
  }
  return v;
}
function setProp(style: string, prop: string, value: string): string {
  const parts = style.split(";").map((p) => p.trim()).filter(Boolean);
  let replaced = false;
  const next = parts.map((p) => {
    const i = p.indexOf(":");
    if (i > 0 && p.slice(0, i).trim().toLowerCase() === prop) { replaced = true; return `${prop}: ${value}`; }
    return p;
  });
  if (!replaced) next.push(`${prop}: ${value}`);
  return next.join("; ") + ";";
}

const FONTS = ["Calibri", "Arial", "Helvetica", "Verdana", "Georgia", "Times New Roman"];
const SERIF = new Set(["Georgia", "Times New Roman"]);
const SWATCHES = ["#000000", "#333333", "#1f3a5f", "#123c2b"];

function fontOf(style: string): string {
  const fam = getProp(style, "font-family") ?? "";
  const first = fam.split(",")[0]?.trim().replace(/["']/g, "");
  return FONTS.find((f) => f.toLowerCase() === first?.toLowerCase()) ?? first ?? "Calibri";
}
function sizeOf(style: string): { n: number; unit: string } {
  const m = (getProp(style, "font-size") ?? "").match(/^([\d.]+)\s*(pt|px)$/);
  return m ? { n: parseFloat(m[1]), unit: m[2] } : { n: 11, unit: "pt" };
}
function colorOf(style: string): string {
  const c = getProp(style, "color") ?? "#000000";
  return /^#[0-9a-fA-F]{3,6}$/.test(c) ? c : "#000000";
}
function gapOf(paragraphStyle: string): number {
  const mb = getProp(paragraphStyle, "margin-bottom");
  if (mb) { const m = mb.match(/([\d.]+)\s*pt/); if (m) return parseFloat(m[1]); }
  const mg = getProp(paragraphStyle, "margin");
  if (mg) { const parts = mg.split(/\s+/); const bottom = parts.length === 4 ? parts[2] : parts[0]; const m = (bottom ?? "").match(/([\d.]+)\s*pt/); if (m) return parseFloat(m[1]); }
  return 12;
}

// ── control atoms ────────────────────────────────────────────────────────────
function ControlLabel({ children }: { children: React.ReactNode }) {
  return <span className="eyebrow mb-1 block text-ink-dim">{children}</span>;
}
function Stepper({ value, unit, onChange, min = 7, max = 24 }: { value: number; unit: string; onChange: (n: number) => void; min?: number; max?: number }) {
  return (
    <div className="flex items-center gap-1">
      <button aria-label="Smaller" onClick={() => onChange(Math.max(min, value - 1))} className="h-7 w-7 rounded-ctl border border-line text-body text-ink-dim hover:bg-fill-2 hover:text-ink">−</button>
      <span className="min-w-[52px] rounded-ctl border border-line bg-well px-2 py-1 text-center text-caption text-ink">{value}{unit}</span>
      <button aria-label="Larger" onClick={() => onChange(Math.min(max, value + 1))} className="h-7 w-7 rounded-ctl border border-line text-body text-ink-dim hover:bg-fill-2 hover:text-ink">+</button>
    </div>
  );
}
function ColorSwatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {SWATCHES.map((c) => (
        <button key={c} aria-label={`Color ${c}`} onClick={() => onChange(c)}
          className={cx("h-6 w-6 rounded-full border-2 transition-transform hover:scale-110", value.toLowerCase() === c ? "border-accent" : "border-line-strong")}
          style={{ background: c }} />
      ))}
      <label className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border-2 border-line-strong" title="Custom color"
        style={{ background: SWATCHES.includes(value.toLowerCase()) ? "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" : value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Custom color picker" />
      </label>
    </div>
  );
}

export function HouseFormat({ header }: { header: React.ReactNode }) {
  const [hf, setHf] = useState<HF | null>(null);
  const [base, setBase] = useState<string>(""); // JSON snapshot for dirty + revert
  const [err, setErr] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);

  const load = useCallback(() => {
    setErr(false);
    fetch("/api/house-format").then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => {
      if (!d.config) return setErr(true);
      setHf(d.config as HF);
      setBase(JSON.stringify(d.config));
    }).catch(() => setErr(true));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { fetch("/api/assets").then((r) => r.json()).then((d) => setAssets(d.files ?? [])).catch(() => {}); }, []);

  const dirty = useMemo(() => hf != null && JSON.stringify(hf) !== base, [hf, base]);
  const previewHtml = useMemo(() => (hf ? renderHouse(hf) : ""), [hf]);
  const srcDoc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}body{padding:22px}</style></head><body>${previewHtml}</body></html>`,
    [previewHtml],
  );

  const set = (fn: (d: HF) => void) => setHf((cur) => { if (!cur) return cur; const next = structuredClone(cur); fn(next); return next; });

  // styled controls write into BOTH body styles so wrapper + paragraphs agree
  const setBodyProp = (prop: string, value: string) => set((d) => {
    d.body.div_style = setProp(d.body.div_style, prop, value);
    d.body.paragraph_style = setProp(d.body.paragraph_style, prop, value);
  });

  const save = async () => {
    if (!hf) return;
    setSaving(true);
    try {
      const res = await fetch("/api/house-format", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: hf }) });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error ?? "save failed");
      setBase(JSON.stringify(hf));
      toast("House format saved — applies to the next Stage/Send", { tone: "ok" });
    } catch (e) {
      toast((e as Error).message, { tone: "bad" });
    } finally {
      setSaving(false);
    }
  };

  if (err) return <div>{header}<ErrorState what="the house format" onRetry={load} /></div>;
  if (!hf) return <div>{header}<Skeleton rows={6} /></div>;

  const font = fontOf(hf.body.paragraph_style);
  const size = sizeOf(hf.body.paragraph_style);
  const color = colorOf(hf.body.paragraph_style);
  const gap = gapOf(hf.body.paragraph_style);

  return (
    <div>
      {header}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_0.9fr]">
        {/* editor — styled controls, no raw CSS on the face */}
        <div className="flex flex-col gap-4">
          <section className="glass rounded-pane p-4">
            <div className="mb-3 text-caption font-medium text-ink-dim">Body text</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <ControlLabel>FONT</ControlLabel>
                <select value={font} aria-label="Body font"
                  onChange={(e) => setBodyProp("font-family", `${e.target.value}, ${SERIF.has(e.target.value) ? "serif" : "sans-serif"}`)}
                  className="w-full rounded-ctl border border-line bg-well px-2.5 py-1.5 text-caption text-ink outline-none focus:border-line-strong">
                  {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div>
                <ControlLabel>SIZE</ControlLabel>
                <Stepper value={size.n} unit={size.unit} onChange={(n) => setBodyProp("font-size", `${n}${size.unit}`)} />
              </div>
              <div>
                <ControlLabel>TEXT COLOR</ControlLabel>
                <ColorSwatches value={color} onChange={(c) => setBodyProp("color", c)} />
              </div>
              <div>
                <ControlLabel>SPACE BETWEEN PARAGRAPHS</ControlLabel>
                <Stepper value={gap} unit="pt" min={0} max={28}
                  onChange={(n) => set((d) => { d.body.paragraph_style = setProp(d.body.paragraph_style, "margin", `0 0 ${n}pt 0`); })} />
              </div>
            </div>
          </section>

          <section className="glass rounded-pane p-4">
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-caption font-medium text-ink-dim">Signature</span>
              <Action variant="ghost" onClick={() => set((d) => { d.signature.lines.push({ text: "", style: `margin: 0; font-family: ${font}, sans-serif; color: #000000;` }); })}>+ ADD A LINE</Action>
            </div>
            <div className="flex flex-col gap-2">
              {hf.signature.lines.map((l, i) => {
                const bold = /font-weight:\s*(bold|[6-9]00)/i.test(l.style);
                return (
                  <div key={i} className="flex items-center gap-2 rounded-card border border-line bg-fill-1 p-2">
                    <input value={l.text} onChange={(e) => set((d) => { d.signature.lines[i].text = e.target.value; })} placeholder="Line text…"
                      className="min-w-0 flex-1 rounded-ctl border border-line bg-well px-2 py-1 text-caption text-ink outline-none focus:border-line-strong"
                      style={{ fontWeight: bold ? 600 : 400 }} />
                    <button aria-pressed={bold} title="Bold"
                      onClick={() => set((d) => { d.signature.lines[i].style = bold ? d.signature.lines[i].style.replace(/font-weight:\s*[^;]+;?/i, "").trim() : setProp(d.signature.lines[i].style, "font-weight", "bold"); })}
                      className={cx("h-7 w-7 shrink-0 rounded-ctl border text-caption font-bold", bold ? "border-accent/60 bg-accent/15 text-ink" : "border-line text-ink-dim hover:bg-fill-2")}>B</button>
                    <ColorSwatches value={colorOf(l.style)} onChange={(c) => set((d) => { d.signature.lines[i].style = setProp(d.signature.lines[i].style, "color", c); })} />
                    <button onClick={() => set((d) => { d.signature.lines.splice(i, 1); })} className="shrink-0 rounded-ctl border border-line px-2 py-1 text-caption text-ink-dim hover:bg-fill-2" title="Remove line">✕</button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="glass rounded-pane p-4">
            <div className="mb-2.5 text-caption font-medium text-ink-dim">Every send also gets</div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <label className="block">
                <ControlLabel>CC ON EVERY EMAIL</ControlLabel>
                <input value={hf.defaults.cc} onChange={(e) => set((d) => { d.defaults.cc = e.target.value; })}
                  className="w-full rounded-ctl border border-line bg-well px-2.5 py-1.5 text-caption text-ink outline-none focus:border-line-strong" />
              </label>
              <label className="block">
                <ControlLabel>DEFAULT ATTACHMENT</ControlLabel>
                {assets.length > 0 ? (
                  <select value={hf.defaults.attach} aria-label="Default attachment"
                    onChange={(e) => set((d) => { d.defaults.attach = e.target.value; })}
                    className="w-full rounded-ctl border border-line bg-well px-2.5 py-1.5 text-caption text-ink outline-none focus:border-line-strong">
                    {!assets.some((a) => a.path === hf.defaults.attach) && <option value={hf.defaults.attach}>{hf.defaults.attach.split("/").pop()}</option>}
                    {assets.map((a) => <option key={a.path} value={a.path}>{a.name}</option>)}
                  </select>
                ) : (
                  <input value={hf.defaults.attach} onChange={(e) => set((d) => { d.defaults.attach = e.target.value; })}
                    className="w-full rounded-ctl border border-line bg-well px-2.5 py-1.5 text-caption text-ink outline-none focus:border-line-strong" />
                )}
              </label>
            </div>
          </section>

          {/* raw CSS + strip-lines — plumbing, off the operator's face */}
          <button onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced} className="eyebrow flex items-center gap-1.5 px-1 text-ink-dim hover:text-ink">
            <span aria-hidden>{advanced ? "▾" : "▸"}</span> ADVANCED — RAW STYLES
          </button>
          {advanced && (
            <section className="glass rounded-pane p-4">
              <div className="flex flex-col gap-2.5">
                <label className="block">
                  <ControlLabel>BODY WRAPPER CSS</ControlLabel>
                  <textarea value={hf.body.div_style} onChange={(e) => set((d) => { d.body.div_style = e.target.value; })} rows={2}
                    className="thin-scroll w-full resize-y rounded-ctl border border-line bg-well px-2.5 py-1.5 font-mono text-caption leading-relaxed text-ink outline-none focus:border-line-strong" />
                </label>
                <label className="block">
                  <ControlLabel>PARAGRAPH CSS</ControlLabel>
                  <textarea value={hf.body.paragraph_style} onChange={(e) => set((d) => { d.body.paragraph_style = e.target.value; })} rows={2}
                    className="thin-scroll w-full resize-y rounded-ctl border border-line bg-well px-2.5 py-1.5 font-mono text-caption leading-relaxed text-ink outline-none focus:border-line-strong" />
                </label>
                {hf.signature.lines.map((l, i) => (
                  <label key={i} className="block">
                    <ControlLabel>SIGNATURE LINE {i + 1} CSS · “{l.text || "—"}”</ControlLabel>
                    <textarea value={l.style} onChange={(e) => set((d) => { d.signature.lines[i].style = e.target.value; })} rows={2}
                      className="thin-scroll w-full resize-y rounded-ctl border border-line bg-well px-2.5 py-1.5 font-mono text-caption leading-relaxed text-ink outline-none focus:border-line-strong" />
                  </label>
                ))}
                <label className="block">
                  <ControlLabel>LINES STRIPPED FROM DRAFT BODIES (THE SIGNATURE RE-ADDS THEM)</ControlLabel>
                  <textarea value={hf.signature.strip_lines.join("\n")} onChange={(e) => set((d) => { d.signature.strip_lines = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean); })}
                    rows={4} className="thin-scroll w-full resize-none rounded-ctl border border-line bg-well px-2.5 py-1.5 font-mono text-caption text-ink-dim outline-none focus:border-line-strong" />
                </label>
              </div>
            </section>
          )}

          <div className="sticky bottom-0 flex items-center gap-2 rounded-card bg-bg-0/80 py-2 backdrop-blur">
            <button onClick={save} disabled={!dirty || saving} className="rounded-ctl bg-accent px-4 py-1.5 text-caption font-medium text-accent-contrast disabled:opacity-40">{saving ? "Saving…" : "Save"}</button>
            <Action variant="neutral" onClick={() => { setHf(JSON.parse(base)); }}>REVERT</Action>
            <span className={cx("ml-1 text-caption font-medium", dirty ? "text-tone-warn-ink" : "text-tone-ok-ink")}>{dirty ? "Unsaved changes" : "✓ Saved"}</span>
          </div>
        </div>

        {/* live preview — an email "device" so the white sheet reads as intentional */}
        <div className="flex flex-col gap-2 self-start lg:sticky lg:top-3">
          <div className="flex items-center gap-2 text-caption text-ink-dim"><span className="text-caption font-medium text-ink-dim">Live preview</span><span>— what the recipient sees</span></div>
          <div className="glass-strong rounded-pane p-3">
            <div className="mx-auto max-w-[560px]">
              <div className="rounded-t-card border border-line bg-fill-2 px-3 py-2 text-micro leading-relaxed text-ink-dim">
                <div>From <span className="text-ink">rep@example.com</span></div>
                <div>To <span className="text-ink">a customer</span> · CC <span className="text-ink">{hf.defaults.cc}</span></div>
              </div>
              <div className="overflow-hidden rounded-b-card bg-white shadow-[0_20px_60px_-30px_rgba(0,0,0,0.9)]">
                <iframe title="Email preview" srcDoc={srcDoc} className="h-[440px] w-full" sandbox="" />
              </div>
            </div>
          </div>
          <p className="text-caption text-ink-dim">Rendered with the same algorithm the sender and stager use. The CC and the attachment ride every send but aren&apos;t shown in this body preview.</p>
        </div>
      </div>
    </div>
  );
}
