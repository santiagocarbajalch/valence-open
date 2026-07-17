"use client";

import { useState } from "react";
import { Action, Empty, StatusChip, TypeTag, toast } from "@/components/kit";
import { pollJob } from "@/lib/pollJob";
import { PackPreview } from "./PackPreview";
import { humanPackTitle, humanTypes } from "./labels";
import type { Pack } from "./types";

// The Drafts drawer body: review → stage → send, one pack per card.
export function PacksList({ packs, onStage, onSend, onAttach, onEdit, onChanged }: {
  packs: Pack[]; onStage: () => void; onSend: (p: Pack) => void;
  onAttach: (file: string, entryIndex: number, current: string[]) => void;
  onEdit: (file: string, entry: number, cur: { subject: string; body: string; to: string }) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, { id: string; running: boolean; ok?: boolean }>>({});
  const shown = packs.slice(0, 12);

  // the pack is the staging unit: warm packs are one company; cold packs are
  // batches and the control SAYS so (the Staged 0→5 honesty fix)
  const isBatch = (p: Pack) => p.count > 1;

  const stage = async (p: Pack) => {
    const res = await fetch("/api/stage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: p.file }) });
    const d = await res.json();
    if (!d.jobId) { toast(`Stage failed: ${d.error ?? "error"}`, { tone: "bad" }); return; }
    setJobs((j) => ({ ...j, [p.file]: { id: d.jobId, running: true } }));
    toast(isBatch(p) ? `Staging the whole batch — ${p.count} drafts to Gmail Drafts…` : "Staging to Gmail Drafts…", { tone: "info" });
    pollJob(d.jobId, (ok) => {
      setJobs((j) => ({ ...j, [p.file]: { id: d.jobId, running: false, ok } }));
      toast(ok ? "✓ Staged to Gmail Drafts" : "Staging stopped at a gate — open the pack", { tone: ok ? "ok" : "warn" });
      onStage();
    }, 3000);
  };

  if (shown.length === 0) return <Empty>No draft packs yet. Draft replies from the cockpit, then review them here.</Empty>;
  return (
    <div className="flex flex-col gap-2">
      {shown.map((p) => {
        const job = jobs[p.file];
        const isOpen = open === p.file;
        return (
          <div key={p.file} className="rounded-card border border-line bg-fill-1">
            <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
              <button onClick={() => setOpen(isOpen ? null : p.file)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-body text-ink">{humanPackTitle(p.label, p.date)}</span>
                <span className="text-caption text-ink-dim">{humanTypes(p.types) || p.status?.toUpperCase()} · {p.count} recipient{p.count !== 1 ? "s" : ""}</span>
              </button>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {p.sent ? <StatusChip tone="ok">sent</StatusChip> : p.staged ? <StatusChip tone="ok">in Gmail Drafts</StatusChip> : <StatusChip tone="dim">not staged</StatusChip>}
                {p.withAttachments > 0 && <TypeTag>{p.withAttachments} attached</TypeTag>}
                <Action onClick={() => setOpen(isOpen ? null : p.file)}>{isOpen ? "Hide" : "Review"}</Action>
                {job?.running ? <span className="px-2 text-body text-ink-dim">Staging…</span> : (
                  <Action onClick={() => stage(p)}
                    title={isBatch(p) ? `Stages every draft in this batch — ${p.count} at once.` : undefined}>
                    {p.staged || job?.ok ? "Re-stage" : isBatch(p) ? `Stage the batch (${p.count})` : "Stage"}
                  </Action>
                )}
                <Action variant="danger" onClick={() => onSend(p)}>Send…</Action>
              </div>
            </div>
            {isOpen && (
              <div className="border-t border-line p-3">
                <PackPreview file={p.file} onAttach={(i, cur) => onAttach(p.file, i, cur)} onEdit={(i, cur) => onEdit(p.file, i, cur)} onChanged={onChanged} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
