// The cockpit's ONE sentence factory (COCKPIT-V4 §6.5, amended parity rule §0.4).
// The engine ships structured facts and its own terminal prose; every sentence
// the CONSOLE shows a human is written or repaired here — nowhere else.
// Copy rules: no console-speak (no "bd", "ball theirs", "cadence-exhausted",
// "(count only)"), abbreviations spelled out, complete sentences.

import { day } from "./types";

// Repair engine display strings that still carry terminal shorthand.
// This is a prose transform only — it never changes what the engine decided.
export function humanizeEngine(s: string): string {
  return s
    .replace(/\bheld until (\d{4}-\d{2}-\d{2})\s*\(operator\)/gi, (_, d: string) => `on hold by you — back ${holdDay(d)}`)
    .replace(/\((\d+)bd quiet\)/gi, "— quiet $1 business days")
    .replace(/(\d+)\s*bd\b/gi, "$1 business days")
    .replace(/\bball theirs\b/gi, "their move")
    .replace(/\bball ours\b/gi, "our move")
    .replace(/\bcadence-exhausted\b/gi, "finished the outreach ladder")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const quietFor = (days: number | null | undefined): string =>
  days == null ? "quiet" : `quiet ${days} business day${days === 1 ? "" : "s"}`;

// row-card tally chip — outbound touches plus replies, exactly as the engine
// counted them. The replies part appears only once the engine ships it.
export const sentRepliesChip = (touches: number | null | undefined, replies: number | null | undefined): string | null =>
  touches == null ? null : `${touches} sent${replies == null ? "" : ` · ${replies} repl${replies === 1 ? "y" : "ies"}`}`;

// "next due <day>" chip — engine-scheduled next touch, when it ships one
export const nextDueChip = (nextDue: string | null | undefined): string | null =>
  nextDue ? `next due ${day(nextDue)}` : null;

// a bounce (DSN in Gmail Spam) proved a send never arrived — say so plainly
export const bounceChip = (b: { date?: string | null; to?: string | null }): string =>
  `send bounced${b.date ? ` ${day(b.date)}` : ""}${b.to ? ` (${b.to})` : ""}`;

// ── V4.2 operator directives (holds + handling-personally) ──────────────────
// engine dates are plain YYYY-MM-DD; noon-anchor so the local day never shifts
export const holdDay = (until: string): string =>
  new Date(until + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

// rail chip on a held row — short, tabular-nums rendered by the chip
export const holdChip = (until: string | null | undefined): string =>
  until ? `back ${new Date(until + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "on hold";

// rail chip on an operator-owned row
export const PERSONAL_CHIP = "yours";

// The cold-outreach tally block (replaces the old run-on cold_line).
export function coldTally(counts: Record<string, number>): { n: number; label: string; expands?: boolean }[] {
  return [
    { n: counts.cold_due ?? 0, label: "due for their next touch", expands: true },
    { n: counts.cold_not_due ?? 0, label: "scheduled for later" },
    { n: counts.cold_exhausted ?? 0, label: "finished the ladder — close-out suggestions only, never nudged again" },
  ];
}

export const frozenLine = (n: number): string =>
  n === 0 ? "Nothing paused" : `${n} compan${n === 1 ? "y" : "ies"} paused by you`;

// A close-out proposal's reasoning, spoken plainly. `reason` is engine
// evidence — render it in full (v4 §7: never truncate the "why").
export function closeOutReason(who: string | undefined, reason: string | undefined): string {
  const w = who && who !== "none" ? who : "";
  // the engine prefixes the reason with the (empty) ask slot — drop a bare "none —"
  const r = humanizeEngine((reason ?? "").replace(/^none\s*[—-]+\s*/i, ""));
  return [w, r].filter(Boolean).join(" — ") || "no reasoning recorded";
}

// What the pinned reply bar says about the draft state (v4 §6.1).
// V5: no staging language — the operator's states are drafted / sent / neither.
export function replyBarLabel(j: { drafted: unknown; staged: string | null; sent: string | null } | undefined, today: string): string {
  if (j?.sent?.startsWith(today)) return "Reply sent today ✓";
  if (j?.drafted) return "Draft ready below";
  return "No draft yet";
}

// ── System drawer plain language (V4.1 — the drawer's jargon exemption is
// revoked; verbatim engine lines live only behind the "Raw engine output" fold).
const localTime = (iso: string | null | undefined): string | null =>
  iso ? new Date(/[Z+]/.test(iso.slice(10)) ? iso : iso + "Z")
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;

export function dataCheckLine(cert: { certified: boolean; mode: string | null; checked_at: string | null }): string {
  if (!cert.certified) return "The independent data check FAILED — treat the board as suspect.";
  // the engine tests startswith("full") — modes like "full-live" count as deep
  const depth = (cert.mode ?? "").startsWith("full") ? "a fresh mailbox read" : "the latest mailbox snapshot";
  const at = localTime(cert.checked_at);
  return `Every count was re-verified against ${depth}${at ? ` at ${at}` : ""}. ✓`;
}

// How many cert lines are real warnings. Line 0 is the verdict; on quick-cert
// days the engine ALSO appends an informational "✅ last FULL cert …" line —
// only the non-✅ lines after the verdict are warnings.
export const certWarnCount = (lines: string[]): number =>
  lines.slice(1).filter((l) => !l.startsWith("✅")).length;

export function boardUpdatedLine(asOf: string | null | undefined, corpusAgeMin: number | null | undefined): string {
  const at = localTime(asOf);
  const corpus = corpusAgeMin == null ? "" :
    corpusAgeMin < 1 ? " · mailbox read moments before" : ` · mailbox last read ${corpusAgeMin} minute${corpusAgeMin === 1 ? "" : "s"} before that`;
  return `Board rebuilt${at ? ` at ${at}` : " recently"}${corpus}.`;
}

export function suppressedSummary(counts: Record<string, number>): string[] {
  const out: string[] = [];
  // inbound_only left this summary 2026-07-11: first-contact senders are now
  // VISIBLE rows on the board ("wrote in first"), not a set-aside count
  const junk = (counts.spam ?? 0) + (counts.probe ?? 0) + (counts.system ?? 0);
  if (junk) out.push(`${junk} junk or automated senders set aside`);
  if (counts.closed) out.push(`${counts.closed} closed as declined`);
  if (counts.dnc) out.push(`${counts.dnc} on the do-not-contact list`);
  return out;
}

export function sendGuardrails(sq: { sentToday: number; cap: number; paused: boolean; pauseReason: string | null; spacingSeconds: number; liveGrants: number; sendEnabled: boolean }): string {
  const state = sq.paused ? `paused (${sq.pauseReason ?? "no reason recorded"})` : sq.sendEnabled ? "on — approved sends go out for real" : "off — nothing leaves, even if approved";
  const grants = sq.liveGrants > 0 ? ` · ${sq.liveGrants} approved send ticket${sq.liveGrants !== 1 ? "s" : ""} open` : "";
  return `${sq.sentToday} of ${sq.cap} sent today · sending is ${state} · one send every ${sq.spacingSeconds} seconds${grants}`;
}

// ── Pipeline tab (2026-07-12) — the whole-field view's sentences ─────────────
// Column blurbs: one plain line under each column header saying what lives
// there and where its actions are. The columns themselves are engine
// partitions (sections / cold_substate / suppressed) — never re-derived.
export const PIPELINE_BLURBS: Record<string, string> = {
  owe: "They wrote last — answer them on Today.",
  them: "Live conversations where the next move is theirs, or you parked them. Bid desks routed internally sit here too — they are never nudged.",
  bids: "Public-sector desks — routed internally, never nudged.",
  meetings: "Companies with a meeting slot proposed or confirmed, any stage. Act on them on Today.",
  scheduled: "Cold leads still on the 3-touch ladder. Today fires each touch when it is due.",
  finished: "Cold leads that got all 3 touches and never answered. Decide: pause them, or leave them here.",
  paused: "Paused by you — they sit out every list and every send until you reactivate them.",
  closed: "Declined. A company re-opens by itself if they write back with interest.",
};

// The short one-phrase note that rides a collapsed count-header (the full
// story lives in the header's "?" hint; this is the at-rest glance).
export const PIPELINE_NOTES: Record<string, string> = {
  scheduled: "each touch fires on Today when due",
  finished: "none answered",
  paused: "out of every list until you reactivate",
  closed: "re-opens on their interest",
};

// a paused row's story: when + why, from the registry the engine honors
export const pausedLine = (meta: { frozen_meta?: { reason?: string | null; frozen_on?: string | null } | null }): string => {
  const fm = meta.frozen_meta;
  const since = fm?.frozen_on ? `paused ${day(fm.frozen_on)}` : "paused";
  return fm?.reason ? `${since} — ${humanizeEngine(fm.reason)}` : since;
};

// a cold row's ladder position, spoken plainly
export const ladderWord = (touches: number, substate: string | undefined, nextDue?: string | null): string => {
  if (substate === "due") return `touch ${touches + 1} of 3 due now`;
  if (substate === "not_due") return nextDue ? `touch ${touches + 1} of 3 scheduled — ${day(nextDue)}` : `touch ${touches + 1} of 3 scheduled`;
  return `${touches} touch${touches === 1 ? "" : "es"} sent — no answer`;
};

// scope-honest bulk control label (tenet 14: the real number, always)
export const pauseSelectedLabel = (n: number): string => `Pause selected (${n})…`;

// The legend for the status dots (v4 §3.3) — one place, rendered wherever needed.
export const DOT_LEGEND: { tone: "bad" | "warn" | "info" | "dim" | "ok"; label: string }[] = [
  { tone: "bad", label: "an answer is owed now" },
  { tone: "warn", label: "attention — a deadline or follow-up window passed" },
  { tone: "info", label: "informational lane (bid desk, added today)" },
  { tone: "dim", label: "waiting — no action needed" },
  { tone: "ok", label: "confirmed done" },
];
