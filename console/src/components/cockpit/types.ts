// Shared cockpit types — the shape of the CANONICAL VIEW (/api/board ←
// core/render_board.py build_view()) plus the write-layer. The cockpit only
// styles this data; it never re-derives classifications or strings.

export interface Note { ts?: string; kind?: string; note?: string; by?: string }
export interface Verdict { summary?: string | null; next_action?: string | null; stale?: boolean; commitments_ours?: string[] | null }
export interface VCells { company: string; who: string; last_in: string; ask: string; last_out: string; action: string }

// board-view v2: the flat cells.action string, kept structured so provenance
// (engine verdict vs Archivist advisory vs operator notes) can render
// distinctly. Same content by construction — build_view() derives both.
// override = the action is a directive/section override (held/personal/close-out/
// in-flight/institutional) that intentionally outranks the Archivist advisory.
export interface ActionParts { engine: string[]; archivist: string | null; archivist_stale: boolean; notes: number; override?: boolean }

export interface RowMeta {
  bucket?: string; state?: string; people: string[];
  last_in_date?: string | null; last_in_from?: string | null; last_in_subj?: string | null; last_in_gist?: string | null;
  last_out_date?: string | null; last_out_gist?: string | null;
  bizdays_since_out?: number | null; touches?: number | null; replies_count?: number | null;
  next_due?: string | null; signals: string[];
  deliverables_missing: string[]; followup_due: boolean; them_last: boolean;
  meeting_at?: string | null; meeting_state?: string | null; meeting_invite_sent?: boolean | null;
  meeting_source?: "registry" | "corpus" | null; meeting_meet_url?: string | null;
  company_class?: string | null;
  // V4.2 operator directives (engine-honored; re-section the view only)
  hold_until?: string | null; hold_reason?: string | null;
  personal?: boolean; personal_reason?: string | null;
  notes: Note[]; key_facts: Record<string, string[]> | null; verdict: Verdict | null;
  suppressed?: string | null;
  frozen_meta?: { reason?: string | null; frozen_on?: string | null; by?: string | null } | null;
  // DSNs found in Gmail Spam proved these sends never arrived (data honesty — loud)
  bounces?: { date?: string | null; to?: string | null }[] | null;
  // Gmail misrouted some of their mail to Spam; it is folded into the thread
  spam_inbound?: boolean | null;
}
export interface VRow { key: string; cells: VCells; meta: RowMeta; action_parts?: ActionParts }
export interface VSection { id: "reply" | "personal" | "held" | "nudge" | "closeout" | "inflight" | "institutional"; title: string; rows: VRow[] }
export interface ColdVRow { key: string; contact: string; people: string[]; touches: number; cold_substate?: string; last_out_date?: string | null; bizdays_since_out?: number | null; next_due?: string | null }

// Cold batch plan (/api/cold-batch ← gen_cold_pack.py --plan). Cold follow-ups
// are templated: within a variant (language × ladder step) every body is the
// same, so ONE sample honestly represents the whole group (operator 2026-07-10).
export interface ColdGroup { lang: "english" | "spanish"; step: "cold-02" | "cold-03"; label: string; count: number; companies: { domain: string; to_email: string; institution: string }[] }
export interface ColdPlan { as_of: string; cold_due: number; groups: ColdGroup[]; dropped_noise: string[]; unresolved_no_send_on_record: string[]; skipped_dnc?: string[] }

export interface View {
  schema: string; certified: boolean;
  cert: { certified: boolean; mode: string | null; checked_at: string | null; lines: string[] };
  columns: string[];
  meetings: { key: string; state: string; line: string; at?: string | null; invite_sent?: boolean | null; meet_url?: string | null; event_id?: string | null }[];
  sections: VSection[];
  cold_line: string;
  proposed_closes: { title: string; items: {
    key: string; who?: string; reason?: string; line: string;
    whose_turn?: "theirs" | "ours"; reason_kind?: "declined" | "verdict-signal";
    evidence_quote?: string | null; last_in_date?: string | null; last_out_date?: string | null;
  }[] };
  frozen_line: string;
  frozen_rows: VRow[];
  // a frozen/closed lead that wrote back after its freeze — the freeze stays on,
  // but the reply is surfaced so it can never sit invisible (the acme-labs.example.com fix).
  pinged_rows?: VRow[];
  // the Auditor's cross-plane data-integrity verdict (auditor.py). Absent on
  // boards built before 2026-07-14.
  audit?: {
    ok: boolean; summary: string; checked_at?: string;
    critical?: number; warnings?: number;
    alerts?: { level: "critical" | "warn"; code: string; detail: string; keys?: string[] }[];
  } | null;
  snapshot: string[];
  counts: Record<string, number>;
  meta: { as_of?: string; today?: string; engine?: string; corpus_age_min?: number | null; degraded: boolean; actionable?: number; companies_total?: number };
  keys: string[];
  // not_due arrives from engines built ≥2026-07-12; older boards omit it
  cold_rows: { due: ColdVRow[]; exhausted: ColdVRow[]; not_due?: ColdVRow[]; dead?: ColdVRow[] };
}

export interface Decision { decision: string; ts: string; note: string }
export interface Journey { drafted: { pack: string; entry: number; type: string; day?: string } | null; staged: string | null; sent: string | null; packSent?: boolean }
export interface Mtimes { corpus: number; board: number; activity: number; drafts: number }
export interface Board {
  ranAt: number; engineErr: string | null;
  regenerated?: boolean; regenReason?: "force" | "dirty" | "stale" | null;
  view: View; decisions: Record<string, Decision>; journeys: Record<string, Journey>; mtimes: Mtimes;
}
export interface Pack { file: string; label: string; date: string | null; status: string | null; count: number; types: string[]; recipients: string[]; withAttachments: number; threaded: boolean; staged: boolean; stagedAt: string | null; sent: boolean; mtime: number }
export interface SQ { sendEnabled: boolean; from: string; cap: number; sentToday: number; remaining: number; paused: boolean; pauseReason: string | null; liveGrants: number; spacingSeconds: number }
export interface ThreadMsg { date: string; dir: "in" | "out"; from: string; to: string; subject: string; body: string; calendar: boolean; auto: boolean; noise: boolean }
export interface Thread { key: string; people: string[]; corpus_pulled_at: string | null; count: number; messages: ThreadMsg[] }

export type GateAction = "freeze" | "unfreeze" | "close" | "dnc";
// V4.2 operator directives — hold-until-a-date and handling-personally
export type DirectiveAction = "hold" | "unhold" | "personal" | "release";


export type Sel =
  | { kind: "row"; key: string; sectionId: string; row: VRow }
  | { kind: "cold"; key: string; cold: ColdVRow }
  | { kind: "fresh"; key: string; known: boolean };

// strip the markdown tells from canonical lines rendered as plain text
export const md = (s: string) => s.replace(/\*\*/g, "").replace(/^###\s*/, "").replace(/^- /, "");
// date-only engine values ("2026-07-01") parse as UTC midnight and render the
// PREVIOUS day in browsers west of UTC — noon-anchor them (same rule as
// prose.holdDay); full timestamps pass through untouched.
const anchored = (ts: string) => (/^\d{4}-\d{2}-\d{2}$/.test(ts) ? ts + "T12:00:00" : ts);
export const day = (ts?: string | null) => (ts ? new Date(anchored(ts)).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
export const dayTime = (ts?: string | null) => (ts ? new Date(anchored(ts)).toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + new Date(anchored(ts)).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "");

export function fmtFacts(kf: Record<string, string[]> | string | null): string {
  if (!kf) return "";
  if (typeof kf === "string") return kf;
  return Object.entries(kf).map(([k, v]) => `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join(" · ");
}
