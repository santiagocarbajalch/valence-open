"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorState, Readout, Skeleton, cx } from "@/components/kit";
import { dayTime, type Thread, type ThreadMsg } from "./types";

// RENDER-TIME body cleanup (Phase T, 2026-07-17) — never mutates the stored
// message; only the DISPLAYED text. Mail clients leave "<mailto:x> x" and
// "<https://y> y" duplicate pairs and runs of blank lines that read as noise
// in the bubbles. Strip the duplicated angle-bracket pairs (and any bare
// leftover wrappers) and collapse 3+ blank lines to a single gap.
function cleanBody(s: string): string {
  return (s || "")
    .replace(/<mailto:([^>]+)>\s+\1/gi, "$1")
    .replace(/<(https?:\/\/[^>]+)>\s+\1/gi, "$1")
    .replace(/<mailto:([^>]+)>/gi, "$1")
    .replace(/<(https?:\/\/[^>]+)>/gi, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// THE conversation renderer — one bubble style on every surface (ONE DESK
// port, 2026-07-12). Today's pane and the Pipeline drawer each rendered the
// same /api/thread payload in different shapes; now both draw these bubbles:
// inbound left on fill, outbound right on the info tint, calendar/auto
// traffic folded to one quiet chip line.

export function MessageList({ messages }: { messages: ThreadMsg[] }) {
  return (
    <ol className="flex flex-col gap-2.5" aria-label="Messages, oldest first">
      {messages.map((m, i) => (
        <li key={i}>
          {m.calendar || m.auto ? (
            <div className="flex items-center gap-2 px-2 text-caption text-ink-dim">
              <span className="shrink-0 rounded-full border border-line px-1.5 py-[1px] text-micro tracking-wide">
                {m.calendar ? "Calendar" : "Auto-reply"}
              </span>
              <span className="truncate" title={m.body || m.subject}>{dayTime(m.date)} — {m.subject || "(no subject)"}</span>
            </div>
          ) : (
            <div className={cx("max-w-[86%] rounded-card border px-3.5 py-2.5",
              m.dir === "in" ? "border-line border-l-[3px] border-l-line-strong bg-bg-2" : "ml-auto border-line bg-well")}>
              <div className={cx("mb-1 flex flex-wrap items-baseline gap-x-2 text-caption text-ink-dim", m.dir === "out" && "justify-end")}>
                <span className="font-medium text-ink">{m.dir === "in" ? m.from : "Us"}</span>
                <Readout className="text-micro">{dayTime(m.date)}</Readout>
                {m.subject && <span className="truncate">· {m.subject}</span>}
              </div>
              <div className="whitespace-pre-wrap text-body leading-relaxed text-ink">{cleanBody(m.body) || "(no text body)"}</div>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

// self-fetching wrapper for surfaces that only have a company key (the
// Pipeline drawer) — same endpoint, same states, same bubbles as Today
export function Conversation({ rowKey }: { rowKey: string }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(() => {
    setThread(null); setErr(false);
    fetch(`/api/thread?key=${encodeURIComponent(rowKey)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((t: Thread) => setThread(t))
      .catch(() => setErr(true));
  }, [rowKey]);
  useEffect(load, [load]);

  if (err) return <ErrorState what="the conversation" onRetry={load} />;
  if (!thread) return <Skeleton rows={3} />;
  if (thread.messages.length === 0) return <p className="text-caption text-ink-dim">No mail on file for this company.</p>;
  return <MessageList messages={thread.messages} />;
}
