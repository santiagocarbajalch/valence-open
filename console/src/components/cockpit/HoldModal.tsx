"use client";

import { useMemo, useState } from "react";
import { Action, Modal, cx } from "@/components/kit";
import { holdDay } from "./prose";

// V4.2 — "Hold until…" date picker. Quick picks (tomorrow, in 2 business days,
// next Monday) plus a custom date. The hold is written to the operator
// directives registry; the engine honors it on both surfaces and the row
// resurfaces ON the chosen date — sooner if the company replies.

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function HoldModal({ company, today, onConfirm, onClose }: {
  company: string; today: string;
  onConfirm: (until: string, reason: string) => void; onClose: () => void;
}) {
  const picks = useMemo(() => {
    const base = new Date(today + "T12:00:00");
    const plusDays = (n: number) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
    const addBiz = (n: number) => {
      const d = new Date(base);
      for (let left = n; left > 0;) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) left--; }
      return d;
    };
    const nextMonday = () => { const d = new Date(base); do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 1); return d; };
    const raw = [
      { label: "Tomorrow", date: fmt(plusDays(1)) },
      { label: "In 2 business days", date: fmt(addBiz(2)) },
      { label: "Next Monday", date: fmt(nextMonday()) },
    ];
    // collapse duplicates (e.g. on a Sunday, "Tomorrow" IS next Monday)
    return raw.filter((p, i) => raw.findIndex((q) => q.date === p.date) === i);
  }, [today]);

  const minDate = picks[0]?.date ?? today;
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(until) && until > today;

  return (
    <Modal title={`Hold until… · ${company}`} onClose={onClose} dirty={reason.trim().length > 0}
      footer={
        <>
          <Action onClick={onClose}>Cancel</Action>
          <button disabled={!valid || !reason.trim()} onClick={() => onConfirm(until, reason.trim())}
            className="rounded-ctl bg-accent px-4 py-1.5 text-caption font-medium text-accent-contrast disabled:opacity-40">
            {valid ? `Hold until ${holdDay(until)}` : "Hold until…"}
          </button>
        </>
      }>
      <p className="mb-3 text-body text-ink-dim">
        The company leaves its list and comes back by itself on the date you pick — sooner if they write back.
        Until then, nothing here suggests touching it.
      </p>
      <div className="flex flex-wrap gap-2">
        {picks.map((p) => (
          <button key={p.date} onClick={() => setUntil(p.date)} aria-pressed={until === p.date}
            className={cx("rounded-card border px-3 py-2 text-left transition-colors",
              until === p.date ? "border-accent bg-fill-2" : "border-line-strong hover:bg-fill-1")}>
            <span className="block text-body font-medium text-ink">{p.label}</span>
            <span className="block text-caption tabular-nums text-ink-dim">{holdDay(p.date)}</span>
          </button>
        ))}
      </div>
      <label className="mt-3 block text-caption text-ink-dim">Or pick a date
        <input type="date" min={minDate} value={until} onChange={(e) => setUntil(e.target.value)}
          className="mt-1 block rounded-card border border-line bg-well px-3 py-2 text-body text-ink outline-none focus:border-line-strong" />
      </label>
      <label className="mt-3 block text-caption text-ink-dim">Why (recorded on the row)
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
          className="mt-1 w-full rounded-card border border-line bg-well px-3 py-2 text-body text-ink outline-none focus:border-line-strong" />
      </label>
    </Modal>
  );
}
