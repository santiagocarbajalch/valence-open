"use client";

import { useEffect, useState } from "react";
import { Action, Readout, toast } from "@/components/kit";
import { IconChevron } from "./icons";
import { boardUpdatedLine, certWarnCount, coldTally, dataCheckLine, frozenLine, sendGuardrails, suppressedSummary } from "./prose";
import { md, day, type SQ, type View } from "./types";

// System status — V4.1 rebuild. Reads like a normal status page (plain sentences
// from prose.ts over structured fields); the verbatim engine/certifier lines live
// behind the ONE collapsed "Raw engine output" fold at the bottom — the only
// copy-lint-exempt surface in the app.
export function SystemPanel({ view, sq, engineErr, onUnfreeze, onChanged }: {
  view: View; sq: SQ | null; engineErr: string | null;
  onUnfreeze?: (key: string, email?: string) => void;
  onChanged?: () => void;
}) {
  const counts = view.counts ?? {};
  // only actual warning lines — the check appends an informational "last FULL
  // cert" line on quick-cert days that must not count (certWarnCount).
  const warns = certWarnCount(view.cert.lines);
  const tally = coldTally(counts);
  return (
    <div className="flex flex-col gap-3 text-body">
      <section aria-label="Data check">
        <h3 className="mb-1 text-body font-medium text-ink">Data check</h3>
        <p className={view.certified ? "text-tone-ok-ink" : "font-medium text-tone-bad-ink"}>
          {view.certified && <span aria-hidden className="mr-1.5 text-st-ok">●</span>}
          {dataCheckLine(view.cert)}
        </p>
        {warns > 0 && (
          <p className="text-tone-warn-ink">{warns} warning{warns !== 1 ? "s" : ""} from the check — details in the raw output below.</p>
        )}
        {engineErr && <p className="mt-1 text-tone-bad-ink">The board engine hit an error — you are looking at the last good board. Details in the raw output below.</p>}
        <p className="mt-1 text-caption text-ink-dim">Before the board is trusted, an independent second read of the mailbox re-counts every row and must agree.</p>
      </section>

      <section aria-label="Today's board">
        <h3 className="mb-1 text-body font-medium text-ink">Today&apos;s board</h3>
        <p className="text-ink-dim">
          <Readout className="text-ink">{view.meta.actionable ?? 0}</Readout> companies need attention · <Readout className="text-ink">{view.meta.companies_total ?? 0}</Readout> tracked in total
        </p>
        <p className="mt-1 text-caption text-ink-dim">Cold outreach:</p>
        {tally.map((t) => (
          <p key={t.label} className="text-ink-dim"><Readout className="text-ink">{t.n}</Readout> {t.label}</p>
        ))}
        {suppressedSummary(counts).map((l) => <p key={l} className="text-ink-dim">{l}</p>)}
        <p className="mt-1 text-caption text-ink-dim">{boardUpdatedLine(view.meta.as_of, view.meta.corpus_age_min)}</p>
      </section>

      <section aria-label="Paused and closed companies">
        <h3 className="mb-1 text-body font-medium text-ink">{frozenLine(counts.frozen ?? 0)}</h3>
        <p className="mb-1 text-caption text-ink-dim">Paused companies sit out every worklist and every send until you reactivate them. History is kept.</p>
        {view.frozen_rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2 py-0.5">
            <span className="min-w-0 flex-1 truncate text-ink-dim">
              <span className="text-ink">{r.key}</span>
              {r.meta.last_in_date ? ` · last heard ${day(r.meta.last_in_date)}` : " · never wrote back"}
              {r.meta.suppressed === "closed" ? " · closed as declined" : ""}
              {r.meta.frozen_meta?.reason ? ` · ${r.meta.frozen_meta.reason}` : ""}
            </span>
            {r.meta.suppressed === "frozen" && onUnfreeze && (
              <Action onClick={() => onUnfreeze(r.key, r.meta.people[0])}>Reactivate</Action>
            )}
          </div>
        ))}
        {view.frozen_rows.length === 0 && <p className="text-ink-dim">Nothing is paused or closed right now.</p>}
      </section>

      {sq && (
        <section aria-label="Sending">
          <h3 className="mb-1 text-body font-medium text-ink">Sending</h3>
          <p className="text-ink-dim">{sendGuardrails(sq)}</p>
          <p className="mt-1 text-caption text-ink-dim">Every send still needs your typed approval in the send dialog; the daily cap and the pacing are hard limits.</p>
        </section>
      )}

      <TestLead onChanged={onChanged} />

      <RawEngineOutput view={view} engineErr={engineErr} />
    </div>
  );
}

// Test lead — prove the whole pipeline (draft → stage → gate → real send) on an
// address YOU own. The engine treats it as a test identity: excluded from every
// count, worklist and cadence. The send gate is byte-identical — no weakening.
function TestLead({ onChanged }: { onChanged?: () => void }) {
  const [st, setSt] = useState<{ email: string; seeded: boolean; packs: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => fetch("/api/test-lead").then((r) => r.json()).then(setSt).catch(() => {});
  useEffect(() => { load(); }, []);

  const act = async (action: "seed" | "purge") => {
    setBusy(true);
    const r = await fetch("/api/test-lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).then((x) => x.json());
    setBusy(false);
    if (r.ok) {
      toast(action === "seed" ? `TEST draft created for ${r.email} — open the Drafts panel to stage and send it to yourself` : "Test drafts purged", { tone: "ok" });
      load(); onChanged?.();
    } else toast(r.error ?? "failed", { tone: "bad" });
  };

  return (
    <section aria-label="Test lead" className="border-t border-line pt-2">
      <h3 className="mb-1 text-body font-medium text-ink">Test the pipeline on yourself</h3>
      <p className="text-caption text-ink-dim">
        Creates a TEST draft addressed to {st?.email ?? "your own inbox"}. It rides the real pipeline — edit, stage, send gate, actual send — but never appears in the counts or worklists. Purge removes it completely.
      </p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Action onClick={() => act("seed")} disabled={busy}>{st?.seeded ? "Re-create test draft" : "Create test draft"}</Action>
        {st && st.packs.length > 0 && <Action variant="danger" onClick={() => act("purge")} disabled={busy}>Purge test drafts</Action>}
      </div>
    </section>
  );
}

// The one surface allowed to show verbatim engine strings (copy-lint exempt).
function RawEngineOutput({ view, engineErr }: { view: View; engineErr: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Raw engine output" className="border-t border-line pt-2">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-ctl border border-line-strong px-3 py-2 text-body text-ink transition-colors hover:bg-fill-2">
        <IconChevron open={open} /> Raw engine output
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-0.5 font-mono text-caption text-ink-dim">
          {view.cert.lines.map((l, i) => <p key={`c${i}`}>{md(l)}</p>)}
          {view.snapshot.map((l, i) => <p key={`s${i}`}>{md(l)}</p>)}
          <p>{md(view.cold_line)}</p>
          <p>{view.frozen_line}</p>
          {engineErr && <p className="text-tone-bad-ink">{engineErr}</p>}
        </div>
      )}
    </section>
  );
}
