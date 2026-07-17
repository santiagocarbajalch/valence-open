"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Action, Chip, ConfirmModal, Hint, Readout, cx, toast } from "@/components/kit";
import { GroupSendModal } from "@/components/cockpit/GroupSendModal";
import { SendModal } from "@/components/cockpit/SendModal";
import { humanDate } from "@/components/cockpit/labels";
import { batchTitle, categoryWord } from "@/lib/leadLabels";

// SCRAPING tab — CALIBRATED INSTRUMENT re-layout 2026-07-17. The three
// operator-approved zones are retitled New dig · Dig in progress · Landed
// batches and stacked as ONE narrow drafting sheet. The pool numbers ride as
// state chips; the live dig keeps every stage/checkpoint but the funnel is
// redrawn as pips/readouts; landed batches are assay strips carrying landed/new
// chips and a per-batch first-email action named for its batch. The "What's
// worked before" veins list left the standing surface (its data still arrives
// on /api/scraping/meta, just unused). One run at a time; every stage advance
// is an operator click. Emailing rides the normal path end-to-end: drafts →
// full check chain → the same guarded send screen as everything else.

interface Category { key: string; label: string }
interface Vein { category: string; country: string; landed: number; lastMined: string; runs: number }
interface HistRow { file: string; batch: string; category: string; geo: string; date: string; landed: number; emailed: number }
interface Tunnel { status: string; total_kept: number; last_kept: number; last_run: string; country: string; name: string; url: string }
interface Meta { categories: Category[]; countries: string[]; pool: { verified: number; uncontacted: number }; veins: Vein[]; history: HistRow[]; sources?: Tunnel[] }
interface BatchLead { institution: string; email: string; country: string; emailed: boolean }
interface SendPack { file: string; label: string; count: number; recipients: string[] }
interface Candidate { url?: string; title?: string; snippet?: string; domain?: string; [k: string]: unknown }
interface Run {
  slug: string; category: string; country: string; count: number;
  phase: string; jobId?: string | null;
  candidates?: Candidate[]; cards?: Candidate[];
  rawSummary?: { leads: number; withEmail: number; roleInboxes: number; urls: number } | null;
  report?: string | null; error?: string | null;
  startedAt: string;
}

const STAGES: { id: string; label: string; covers: string[] }[] = [
  { id: "discover", label: "Discover", covers: ["discover", "review_discover"] },
  { id: "qualify", label: "Qualify", covers: ["qualify", "review_qualify"] },
  { id: "scrape", label: "Scrape", covers: ["scrape", "review_scrape"] },
  { id: "icp", label: "Fit check", covers: ["icp"] },
  { id: "verify", label: "Verify + land", covers: ["verify"] },
];
const RUNNING = new Set(["discover", "qualify", "scrape", "icp", "verify"]);
const REVIEW = new Set(["review_discover", "review_qualify", "review_scrape"]);

type StageState = "done" | "running" | "review" | "todo";
function stageStateOf(run: Run, covers: string[]): StageState {
  const order = STAGES.flatMap((s) => s.covers);
  const cur = order.indexOf(run.phase);
  const first = order.indexOf(covers[0]);
  if (run.phase === "done") return "done";
  if (covers.includes(run.phase)) return RUNNING.has(run.phase) ? "running" : "review";
  return first < cur ? "done" : "todo";
}

// The dig funnel as a row of pips (CALIBRATED INSTRUMENT): five stage readouts,
// state carried by SHAPE (✓ done · ● at work · ○ ahead), never by tint alone,
// so it reads identically on the drafting sheet (day) and the blueprint (night).
// A thin track under it fills with the fraction of stages already cleared.
function StageRail({ run }: { run: Run }) {
  const done = STAGES.filter((st) => stageStateOf(run, st.covers) === "done").length;
  const frac = Math.round((done / STAGES.length) * 100);
  return (
    <div className="mt-3">
      <ol aria-label="Dig progress" className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
        {STAGES.map((st) => {
          const s = stageStateOf(run, st.covers);
          const glyph = s === "done" ? "✓" : s === "running" || s === "review" ? "●" : "○";
          return (
            <li key={st.id} aria-current={s === "running" || s === "review" ? "step" : undefined}
              className={cx("readout inline-flex items-baseline gap-1.5 whitespace-nowrap text-caption",
                s === "done" ? "text-tone-ok-ink" : s === "running" ? "text-accent"
                  : s === "review" ? "font-medium text-tone-warn-ink" : "text-ink-dim")}>
              <span aria-hidden style={s === "running" ? { animation: "breathe 2.2s var(--ease-soft) infinite" } : undefined}>{glyph}</span>
              <span>{st.label}</span>
              {s === "running" && <span className="text-micro text-accent">working…</span>}
              {s === "review" && <span className="text-micro font-medium text-tone-warn-ink">your call</span>}
            </li>
          );
        })}
      </ol>
      <div aria-hidden className="mt-2.5 h-1 overflow-hidden rounded-full bg-well">
        <div className="h-full rounded-full bg-[var(--st-due)] transition-[width]" style={{ width: `${frac}%` }} />
      </div>
    </div>
  );
}

// checkpoint chrome: the warn LEFT BAR carries the "stop, read this" meaning —
// the faint tint alone washed out on the night blueprint (live audit finding)
const CHECKPOINT = "mt-3 rounded-card border border-tone-warn/45 border-l-[3px] border-l-tone-warn bg-tone-warn/[0.07] p-3";

// checkpoint list: summary line + per-item details fold (operator decision).
// Every truncated string carries its full text on hover AND in the fold —
// review means reading, so nothing may be cut off with no way to read it.
function PickList({ items, picked, onToggle, detail }: {
  items: Candidate[]; picked: Set<number>; onToggle: (i: number) => void;
  detail: (c: Candidate) => string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul className="thin-scroll max-h-[320px] overflow-y-auto">
      {items.map((c, i) => (
        <li key={i} className="border-b border-line py-1 last:border-0">
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={picked.has(i)} onChange={() => onToggle(i)}
              aria-label={`include ${domainOf(c)}`} className="accent-[var(--accent)]" />
            <button onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i} title={domainOf(c)}
              className="min-w-0 flex-1 truncate text-left text-body text-ink hover:underline">
              {domainOf(c)}
            </button>
            <span title={String(c.title ?? "")} className="max-w-[45%] shrink-0 truncate text-caption text-ink-dim">{c.title ?? ""}</span>
          </div>
          {open === i && <p className="mt-1 pl-6 text-caption text-ink-dim">{detail(c) || "no further detail"}</p>}
        </li>
      ))}
    </ul>
  );
}

function domainOf(c: Candidate): string {
  try { return c.domain || new URL(c.url ?? "").hostname.replace(/^www\./, ""); } catch { return c.url ?? "?"; }
}

// plain words for the discovery tool's source states (the tool decides the
// state; this only translates the enum for display)
const SOURCE_WORD: Record<string, { word: string; cls: string }> = {
  FRESH: { word: "never dug", cls: "text-ink-dim" },
  PRODUCTIVE: { word: "giving leads", cls: "text-tone-ok-ink" },
  "TAPPED-OUT": { word: "used up", cls: "text-ink-dim" },
  "DRY-ICP": { word: "noisy — no real leads", cls: "text-tone-warn-ink" },
  ERROR: { word: "failing", cls: "text-tone-bad-ink" },
};

// one landed batch as an assay strip: a state-hued left bar (fresh leads still
// to reach = ok, otherwise idle), landed/new chips, a mono date, and — only
// while anyone is still fresh — a first-email action NAMED for its batch (a11y
// audit fix: "Email N fresh — <batch>…", never a bare "Email the fresh ones").
// The name still folds open the companies inside, contacted ones labeled.
function BatchRow({ h, onEmail }: { h: HistRow; onEmail: () => void }) {
  const [open, setOpen] = useState(false);
  const [leads, setLeads] = useState<BatchLead[] | null>(null);
  const toggle = () => {
    setOpen(!open);
    if (!open && leads === null) {
      fetch(`/api/scraping/batch?file=${encodeURIComponent(h.file)}`)
        .then((r) => r.json()).then((d) => setLeads(d.leads ?? [])).catch(() => setLeads([]));
    }
  };
  const title = batchTitle(h.category, h.geo);
  const fresh = h.landed - h.emailed;
  const emptyBatch = h.landed === 0;
  return (
    <li className="mb-1.5">
      <div className={cx("assay-strip flex items-center gap-2.5 rounded-ctl py-1.5 pl-3 pr-2.5",
        fresh > 0 ? "hue-ok" : "hue-idle")}>
        <button onClick={toggle} aria-expanded={open} title={title}
          className="min-w-0 flex-1 truncate text-left text-body font-medium text-ink hover:underline">
          {title}
        </button>
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          {emptyBatch ? (
            <Chip hue="idle">nothing landed</Chip>
          ) : (
            <>
              <Chip hue="idle"><Readout>{h.landed}</Readout> landed</Chip>
              {fresh > 0 && <Chip hue="ok"><Readout>{fresh}</Readout> new</Chip>}
            </>
          )}
        </span>
        <span className="readout shrink-0 text-caption text-ink-dim" title={h.date}>{humanDate(h.date) || h.date}</span>
      </div>
      {fresh > 0 && (
        <div className="ml-3 mt-1">
          <Action onClick={onEmail} title={`First email to the ${fresh} fresh compan${fresh === 1 ? "y" : "ies"} in ${title}`}>
            Email {fresh} fresh — {title}…
          </Action>
        </div>
      )}
      {open && (
        <ul className="thin-scroll ml-3 mt-1 max-h-48 overflow-y-auto rounded-ctl bg-fill-1 px-2 py-1">
          {leads === null && <li className="py-1 text-caption text-ink-dim">loading…</li>}
          {leads?.map((l, i) => (
            <li key={i} className="flex items-baseline gap-2 border-b border-line py-1 last:border-0">
              <span title={l.institution || l.email} className="min-w-0 flex-1 truncate text-caption text-ink">{l.institution || l.email}</span>
              <span title={l.email} className="min-w-0 max-w-[45%] shrink truncate text-caption text-ink-dim">{l.email}</span>
              {l.emailed && <span className="shrink-0 text-caption text-ink-dim">emailed</span>}
            </li>
          ))}
          {leads?.length === 0 && <li className="py-1 text-caption text-ink-dim">nothing readable in this batch</li>}
        </ul>
      )}
    </li>
  );
}

export function ScrapingView() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [category, setCategory] = useState("");
  const [country, setCountry] = useState("");
  const [countStr, setCountStr] = useState("20");
  const [confirmStart, setConfirmStart] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [useLlm, setUseLlm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emailFor, setEmailFor] = useState<HistRow | null>(null);
  const [sendPack, setSendPack] = useState<SendPack | null>(null);
  const pickedFor = useRef<string | null>(null);

  const loadMeta = useCallback(() => {
    fetch("/api/scraping/meta").then((r) => r.json()).then(setMeta).catch(() => {});
  }, []);
  const loadRun = useCallback(() => {
    fetch("/api/scraping/run").then((r) => r.json()).then((d) => setRun(d.run ?? null)).catch(() => {});
  }, []);
  useEffect(() => { loadMeta(); loadRun(); }, [loadMeta, loadRun]);

  // poll ONLY while a stage is actually executing (job-poll pattern, not idle polling)
  useEffect(() => {
    if (!run || !RUNNING.has(run.phase)) return;
    const t = setInterval(loadRun, 4000);
    return () => clearInterval(t);
  }, [run, loadRun]);

  // default-select everything when a new checkpoint lands
  useEffect(() => {
    if (!run || !REVIEW.has(run.phase)) return;
    const key = `${run.slug}:${run.phase}`;
    if (pickedFor.current === key) return;
    pickedFor.current = key;
    const pool = run.phase === "review_qualify" ? run.cards : run.candidates;
    setPicked(new Set((pool ?? []).map((_, i) => i)));
  }, [run]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    const r = await fetch("/api/scraping/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    setBusy(false);
    if (!r.ok) { toast(d.error ?? "That didn't work", { tone: "bad" }); return null; }
    setRun(d.run ?? null);
    return d;
  };

  // the picker submits keys; the operator only ever reads labels
  const catLabel = useCallback(
    (key: string) => meta?.categories.find((c) => c.key === key)?.label ?? categoryWord(key),
    [meta],
  );

  const count = Math.floor(Number(countStr));
  const countOk = countStr.trim() !== "" && Number.isFinite(count) && count >= 1 && count <= 100;

  const start = async () => {
    setConfirmStart(false);
    if (await post({ action: "start", category, country, count })) toast(`Dig started — ${catLabel(category)} · ${country}`, { tone: "info" });
  };
  const cont = (extra?: Record<string, unknown>) => post({ action: "continue", approved: [...picked], ...extra });

  // checks passed → open the SAME guarded send confirm every pack uses
  const openSend = async (file: string) => {
    setEmailFor(null);
    const d = (await fetch("/api/drafts").then((r) => r.json()).catch(() => null)) as { packs?: SendPack[] } | null;
    const p = d?.packs?.find((x) => x.file === file);
    if (!p) { toast("The drafts moved — find them in Today's Drafts drawer.", { tone: "warn" }); return; }
    setSendPack(p);
  };

  const active = run && !["done", "error", "cancelled"].includes(run.phase);
  // the disabled start button always says WHY, on the button and under it —
  // a greyed control with no reason reads as broken (live audit finding)
  const startWhy = active ? "One dig at a time — finish or cancel the one running first."
    : !category || !country ? "Pick a category and a country first."
    : !countOk ? "Fix the lead count first." : null;

  return (
    <div className="thin-scroll mx-auto h-full max-w-[760px] overflow-y-auto px-5 pb-16 pt-5">
      <h1 className="text-display font-medium text-ink">Scraping</h1>

      {/* ── NEW DIG ──────────────────────────────────────────────────── */}
      <h2 className="mt-4 mb-2 text-micro font-semibold uppercase tracking-[0.08em] text-ink-dim">New dig</h2>
      <section aria-label="New dig">
        <form onSubmit={(e) => e.preventDefault()} className="flex flex-wrap items-end gap-3.5">
          <label className="flex min-w-0 flex-col gap-1 text-caption text-ink-dim">Category
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="min-w-[190px] rounded-ctl border border-line-strong bg-well px-2.5 py-1.5 text-body text-ink outline-none focus:border-accent">
              <option value="">pick one…</option>
              {(meta?.categories ?? []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-caption text-ink-dim">Country
            <select value={country} onChange={(e) => setCountry(e.target.value)}
              className="min-w-[160px] rounded-ctl border border-line-strong bg-well px-2.5 py-1.5 text-body text-ink outline-none focus:border-accent">
              <option value="">pick one…</option>
              {(meta?.countries ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="flex w-24 flex-col gap-1 text-caption text-ink-dim">How many
            <input type="number" min={1} max={100} value={countStr} onChange={(e) => setCountStr(e.target.value)}
              aria-invalid={!countOk}
              className="rounded-ctl border border-line-strong bg-well px-2.5 py-1.5 text-body text-ink outline-none focus:border-accent" />
          </label>
          <Action variant="primary" title={startWhy ?? undefined} onClick={() => setConfirmStart(true)} disabled={!!startWhy || busy}>
            Start the dig…
          </Action>
          <Hint label="What is a dig?" className="mb-2">
            A dig finds and verifies new lead companies for one category and country. About 30 minutes, five review stops, spends agent time. It never sends email.
          </Hint>
        </form>
        {!countOk && <p className="mt-1.5 text-caption text-tone-warn-ink">Pick a number between 1 and 100.</p>}
        {startWhy && <p className="mt-1.5 text-caption text-ink-dim">{startWhy}</p>}
      </section>

      {/* pool numbers as state chips */}
      {meta && (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <Chip hue="idle"><Readout>{meta.pool.uncontacted}</Readout> uncontacted</Chip>
            <Chip hue="idle"><Readout>{meta.pool.verified}</Readout> verified</Chip>
            <Chip hue="idle"><Readout>{meta.sources?.length ?? 0}</Readout> sources</Chip>
          </div>
          <p className="mt-2 text-caption text-ink-dim">
            The never-emailed leads are ready to pull from Today&apos;s &ldquo;Add leads&rdquo; before digging for more.
          </p>
        </>
      )}

      {/* ── DIG IN PROGRESS ──────────────────────────────────────────── */}
      <h2 className="mt-8 mb-2 text-micro font-semibold uppercase tracking-[0.08em] text-ink-dim">Dig in progress</h2>
      <section aria-label="Dig in progress" aria-live="polite">
          {!run && <p className="text-body text-ink-dim">No dig running. Pick a category and a country above, then start one.</p>}

          {run && (
            <>
              <p className="text-body text-ink">
                {catLabel(run.category)} · {run.country} — aiming for {run.count}
                <span className="ml-2 text-caption text-ink-dim">started {new Date(run.startedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
              </p>

              <StageRail run={run} />

              {/* running */}
              {RUNNING.has(run.phase) && (
                <p className="mt-3 text-body text-accent" role="status"><span aria-hidden>✦ </span>
                  {run.phase === "discover" ? "Searching for candidate sources…"
                    : run.phase === "qualify" ? "Gathering size evidence on each company…"
                    : run.phase === "scrape" ? "Extracting contacts from the approved sites (this is the slow one)…"
                    : run.phase === "icp" ? "Reading what each company actually does…"
                    : "Verifying addresses and landing the batch in the vault…"}
                </p>
              )}

              {/* checkpoints — summary first, details fold per row */}
              {run.phase === "review_discover" && (
                <div className={CHECKPOINT}>
                  <p className="text-micro font-medium uppercase tracking-wide text-tone-warn-ink">Checkpoint — your call</p>
                  <p className="mt-1 text-body text-ink">
                    <span className="font-medium">{run.candidates?.length ?? 0} candidate sources found.</span>{" "}
                    Untick anything off-target (wrong country, marketplaces, industrial), then continue.
                  </p>
                  <div className="mt-1.5"><PickList items={run.candidates ?? []} picked={picked} onToggle={(i) => setPicked((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; })} detail={(c) => [c.title, c.snippet].filter(Boolean).join(" — ")} /></div>
                  <div className="mt-2 flex justify-end gap-1.5">
                    <Action onClick={() => post({ action: "cancel" })}>Cancel the dig</Action>
                    <Action variant="primary" onClick={() => cont()} disabled={busy || picked.size === 0}>Continue with {picked.size}</Action>
                  </div>
                </div>
              )}
              {run.phase === "review_qualify" && (
                <div className={CHECKPOINT}>
                  <p className="text-micro font-medium uppercase tracking-wide text-tone-warn-ink">Checkpoint — your call</p>
                  <p className="mt-1 text-body text-ink">
                    <span className="font-medium">{run.cards?.length ?? 0} companies with size evidence.</span>{" "}
                    Open a row to read its evidence card; untick the ones too small to buy.
                  </p>
                  <div className="mt-1.5"><PickList items={run.cards ?? []} picked={picked} onToggle={(i) => setPicked((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    detail={(c) => ["employee_band", "import_records", "tenders", "reach", "low_web_footprint"].map((k) => c[k] != null ? `${k.replace(/_/g, " ")}: ${JSON.stringify(c[k])}` : null).filter(Boolean).join(" · ")} /></div>
                  <div className="mt-2 flex justify-end gap-1.5">
                    <Action onClick={() => post({ action: "cancel" })}>Cancel the dig</Action>
                    <Action variant="primary" onClick={() => cont()} disabled={busy || picked.size === 0}>Scrape {picked.size} sites</Action>
                  </div>
                </div>
              )}
              {run.phase === "review_scrape" && (
                <div className={CHECKPOINT}>
                  <p className="text-micro font-medium uppercase tracking-wide text-tone-warn-ink">Checkpoint — your call</p>
                  <p className="mt-1 text-body text-ink">
                    <span className="font-medium">Raw haul: {run.rawSummary?.withEmail ?? 0} contacts</span>
                    {run.rawSummary ? ` from ${run.rawSummary.urls} sites — ${run.rawSummary.roleInboxes} shared team inboxes like info@ or sales@ (the real buyers here).` : "."}
                  </p>
                  <label className="mt-1.5 flex items-center gap-2 text-caption text-ink-dim">
                    <input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} className="accent-[var(--accent)]" />
                    Use the smarter (paid) read for the fit check — better on new markets
                  </label>
                  <p className="mt-1 text-caption text-ink-dim">Continuing runs the fit check, then verification — verified leads land in the vault automatically.</p>
                  <div className="mt-2 flex justify-end gap-1.5">
                    <Action onClick={() => post({ action: "cancel" })}>Cancel the dig</Action>
                    <Action variant="primary" onClick={() => cont({ llm: useLlm })} disabled={busy}>Check fit + verify</Action>
                  </div>
                </div>
              )}

              {run.phase === "done" && (
                <div className="mt-3 rounded-card border border-tone-ok/40 border-l-[3px] border-l-tone-ok bg-tone-ok/[0.06] p-3">
                  <p className="text-body font-medium text-tone-ok-ink">Dig finished — the verified leads are in the vault.</p>
                  {run.report && <pre className="thin-scroll mt-1.5 max-h-56 max-w-full overflow-auto whitespace-pre-wrap font-mono text-micro text-ink-dim">{run.report}</pre>}
                  <div className="mt-2 flex justify-end"><Action onClick={() => { post({ action: "dismiss" }); loadMeta(); }}>Close</Action></div>
                </div>
              )}
              {run.phase === "error" && (
                <div className="mt-3 rounded-card border border-tone-bad/45 border-l-[3px] border-l-tone-bad bg-tone-bad/[0.06] p-3">
                  <p className="text-body font-medium text-tone-bad-ink">The dig stopped.</p>
                  <p className="mt-1 whitespace-pre-wrap text-caption text-ink-dim">{run.error}</p>
                  <div className="mt-2 flex justify-end"><Action onClick={() => post({ action: "dismiss" })}>Clear</Action></div>
                </div>
              )}
              {run.phase === "cancelled" && (
                <div className="mt-3 rounded-card border border-line p-3">
                  <p className="text-body text-ink-dim">Dig cancelled — nothing further will run.</p>
                  <div className="mt-2 flex justify-end"><Action onClick={() => post({ action: "dismiss" })}>Clear</Action></div>
                </div>
              )}
              {active && RUNNING.has(run.phase) && (
                <div className="mt-3 flex justify-end">
                  <Action onClick={() => post({ action: "cancel" })}>Cancel — current step finishes, nothing further runs</Action>
                </div>
              )}
            </>
          )}
        </section>

      {/* ── LANDED BATCHES ───────────────────────────────────────────── */}
      <h2 className="mt-8 mb-2 text-micro font-semibold uppercase tracking-[0.08em] text-ink-dim">Landed batches</h2>
      <section aria-label="Landed batches">
        {(meta?.history.length ?? 0) === 0 && <p className="text-body text-ink-dim">No landed batches yet. Finish a dig and its batch shows up here.</p>}
        <ul>
          {(meta?.history ?? []).map((h) => (
            <BatchRow key={h.file} h={h} onEmail={() => setEmailFor(h)} />
          ))}
        </ul>

        {(meta?.sources?.length ?? 0) > 0 && (
          <details className="mt-3 border-t border-line pt-2.5">
            <summary className="cursor-pointer text-micro font-semibold uppercase tracking-[0.08em] text-ink-dim">
              Where we&apos;ve dug ({meta!.sources!.length} sources)
            </summary>
            <ul className="thin-scroll mt-1.5 max-h-[40vh] overflow-y-auto">
              {meta!.sources!.map((s) => {
                const w = SOURCE_WORD[s.status] ?? { word: s.status.toLowerCase(), cls: "text-ink-dim" };
                return (
                  <li key={s.url} className="border-b border-line py-1 last:border-0">
                    <div className="flex items-baseline gap-2">
                      <span title={s.url} className="min-w-0 flex-1 truncate text-caption text-ink">{s.name}</span>
                      <span className={cx("shrink-0 text-caption", w.cls)}>{w.word}</span>
                    </div>
                    <div className="text-caption text-ink-dim">
                      {s.country}{s.total_kept > 0 ? ` · ${s.total_kept} found` : ""}{s.last_run !== "-" ? ` · last dug ${humanDate(s.last_run) || s.last_run}` : ""}
                    </div>
                  </li>
                );
              })}
            </ul>
          </details>
        )}

        <p className="mt-3 border-t border-line pt-2.5 text-caption text-ink-dim">
          Landed leads also feed Today&apos;s &ldquo;Add leads&rdquo; picker — the fresh ones first.
        </p>
      </section>

      {emailFor && (
        // the shared group-send screen (same one Today's cold groups use);
        // first-emails mode opens with the plan — who is fresh, who is left out
        <GroupSendModal source={{ kind: "first-emails", batchFile: emailFor.file, batchLabel: batchTitle(emailFor.category, emailFor.geo) }}
          onClose={() => setEmailFor(null)} onStaged={openSend} />
      )}
      {sendPack && (
        <SendModal pack={sendPack} onClose={() => setSendPack(null)}
          onDone={() => { setSendPack(null); loadMeta(); }} />
      )}

      {confirmStart && (
        <ConfirmModal
          title={`Start the dig · ${catLabel(category)} · ${country}`}
          body={<>Searches the web for ~{count * 2} candidate sources, then walks Discover → Qualify → Scrape → Fit check → Verify with a review stop at each gate. Uses agent time and runs 20–40 minutes across the stages; you approve every list before the next stage spends anything. It never sends email.</>}
          confirmLabel="Start the dig"
          onConfirm={start}
          onClose={() => setConfirmStart(false)}
        />
      )}
    </div>
  );
}
