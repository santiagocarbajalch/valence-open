// Server-only pipeline truth helpers shared by the cockpit API routes.
// Everything here DERIVES state from the durable artifacts — the activity log,
// the draft packs, the .staged.json markers and the sent/ batch records — so the
// cockpit's pipeline view always reflects what actually happened, never UI state.
import fs from "node:fs";
import path from "node:path";
import { VAULT } from "@/lib/vault";

// New-mail head-poll sources: pulls.jsonl is appended by every real corpus pull
// (~10 min cadence); board.json is rewritten whenever truth.py regenerates.
// (The old company_corpus.json is a dead 99-byte stub — never stat it.)
export const CORPUS_PULLS = path.join(VAULT, "inbox/intel/corpus/pulls.jsonl");
export const BOARD_FILE = path.join(VAULT, "state/board.json");
export const ACTIVITY = path.join(VAULT, "inbox/intel/lead_activity.jsonl");
export const DRAFTS_DIR = path.join(VAULT, "pipeline/drafts");
export const SENT_DIR = path.join(VAULT, "pipeline/sent");
export const DIRTY_FILE = path.join(VAULT, "state/board.dirty");

// ── board dirty marker ───────────────────────────────────────────────────────
// Mutations that write ENGINE-consumed registries (operator-frozen.json, closed,
// dnc, meetings.json) call markBoardDirty; the board route then re-runs truth.py
// even inside the 5-min freshness window. Self-clearing: a successful engine run
// rewrites board.json, whose newer mtime ends the dirty condition — a mutation
// landing mid-regen re-dirties for the next GET.
export function markBoardDirty(reason: string): void {
  try {
    fs.mkdirSync(path.dirname(DIRTY_FILE), { recursive: true });
    fs.writeFileSync(DIRTY_FILE, JSON.stringify({ ts: new Date().toISOString(), reason }) + "\n", "utf8");
  } catch { /* best-effort — worst case the 5-min window applies */ }
}
export function boardIsDirty(): boolean {
  const stat = (p: string) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  const dirty = stat(DIRTY_FILE);
  return dirty > 0 && dirty > stat(BOARD_FILE);
}

// company key for an email — pure logic in lib/companyKey.ts (client + server)
import { companyKey } from "@/lib/companyKey";
export { companyKey };

// ── today's operator decisions from the durable activity log ────────────────
export interface Decision { decision: string; ts: string; note: string }
export function readDecisions(today: string): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  let raw = "";
  try { raw = fs.readFileSync(ACTIVITY, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { domain?: string; ts?: string; kind?: string; note?: string; decision?: string };
      if (r.kind !== "decision" || !r.domain || !r.ts) continue;
      if (!r.ts.startsWith(today)) continue; // decisions are per-day
      const prev = out[r.domain];
      if (!prev || r.ts > prev.ts) out[r.domain] = { decision: r.decision ?? (r.note ?? "").split(" ")[0], ts: r.ts, note: r.note ?? "" };
    } catch { /* skip bad line */ }
  }
  return out;
}

export function appendDecision(domain: string, decision: string, detail?: string, by = "operator") {
  const rec = {
    domain,
    ts: new Date().toISOString().replace(/\.\d+Z$/, "+00:00"),
    kind: "decision",
    decision,
    note: detail ? `${decision} — ${detail}` : decision,
    by,
  };
  fs.mkdirSync(path.dirname(ACTIVITY), { recursive: true });
  fs.appendFileSync(ACTIVITY, JSON.stringify(rec) + "\n", "utf8");
  return rec;
}

// ── pipeline derivation from real artifacts ─────────────────────────────────
interface PackEntry { to_email?: string; draft_type?: string; subject?: string; _thread?: string }
export interface Journey { drafted: { pack: string; entry: number; type: string; day: string } | null; staged: string | null; sent: string | null; packSent: boolean }

// Per-file parse caches keyed by mtime. deriveJourneys runs on every board load
// AND every 30s head-poll, and pipeline/drafts/ grows without bound, so
// re-JSON.parsing every pack on every call was the console's #1 hot-path cost
// (2026-07-12 agent-file audit). A stat is orders cheaper than a parse; any
// rewrite bumps mtime, which invalidates that file's entry. Truth still comes
// from disk every call — only the parse of UNCHANGED bytes is skipped.
interface PackCacheEntry { mtime: number; recipients: { key: string; entry: number; type: string }[]; stagedInPack: string | null }
const packCache = new Map<string, PackCacheEntry>();
interface SentCacheEntry { mtime: number; recs: { key: string; at: string }[] }
const sentCache = new Map<string, SentCacheEntry>();
function prune<T>(cache: Map<string, T>, live: Set<string>): void {
  if (cache.size <= live.size) return;
  for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
}

// A pack filename in plain words for operator-facing surfaces (task tray,
// toasts): "2026-07-13__cold-followups__spanish__cold-02.json" reads as
// "cold follow-ups · Spanish · 2nd follow-up". Filenames are jargon (operator
// ruling 2026-07-13); the file itself keeps its name everywhere else.
const PACK_WORD: Record<string, string> = {
  "cold-followups": "cold follow-ups",
  "cold-01": "first email",
  "cold-02": "2nd follow-up",
  "cold-03": "3rd follow-up",
  english: "English",
  spanish: "Spanish",
};
export function humanPackName(file: string): string {
  const base = file.replace(/\.threaded\.json$|\.json$/, "");
  const parts = base.split("__");
  if (parts.length < 2) return base;
  const words = parts.slice(1).map((p) => PACK_WORD[p] ?? p.replace(/-/g, " "));
  return words.join(" · ");
}

export function deriveJourneys(): Record<string, Journey> {
  const j: Record<string, Journey> = {};
  const touch = (key: string): Journey => (j[key] ??= { drafted: null, staged: null, sent: null, packSent: false });
  const statMs = (p: string) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  // the DAY each company's winning draft was authored (carried on the drafted
  // pointer) — feeds the staleness rules here and in /api/board. The filename
  // date (batch naming convention) is the semantic signal; file mtime lies
  // (machinery rewrites old packs: staged-field writes, sibling edits —
  // Sirius's June 22 pack carried a July 10 mtime).
  const packDay = (name: string, mtimeMs: number): string => {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : new Date(mtimeMs).toISOString().slice(0, 10);
  };

  // sent-pack truth = a matching per-recipient record in pipeline/sent/ (same
  // base-name match /api/drafts uses). A sent pack's draft card must never
  // offer Send again — the 2026-07-12 test send left a live Send button on an
  // already-delivered draft.
  let sentNames: string[] = [];
  try { sentNames = fs.readdirSync(SENT_DIR).filter((n) => n.endsWith(".json")); } catch { /* none */ }
  const sentBases = sentNames.map((n) => n.replace(/\.json$/, ""));
  const packWasSent = (name: string) => {
    const base = name.replace(/\.json$/, "");
    return sentBases.some((s) => s.includes(base) || base.includes(s.replace(/^\d{4}-\d{2}-\d{2}-/, "")));
  };

  // drafted + staged: walk the base packs newest-last so the latest pack wins a key
  let packs: { n: string; m: number }[] = [];
  try {
    packs = fs.readdirSync(DRAFTS_DIR)
      .filter((n) => n.endsWith(".json") && !n.endsWith(".threaded.json") && !n.endsWith(".staged.json"))
      .map((n) => ({ n, m: statMs(path.join(DRAFTS_DIR, n)) }))
      .sort((a, b) => a.m - b.m);
  } catch { /* none */ }
  for (const { n: name, m } of packs) {
    let c = packCache.get(name);
    if (!c || c.mtime !== m) {
      let pack: Record<string, unknown>;
      try { pack = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, name), "utf8")); } catch { continue; }
      const inPack = typeof pack.staged === "object" && pack.staged !== null ? (pack.staged as { at?: string | number }) : null;
      const stagedInPack = inPack && inPack.at !== undefined && inPack.at !== null && inPack.at !== "" ? String(inPack.at) : null;
      const recipients: PackCacheEntry["recipients"] = [];
      const lists = Object.values(pack).filter(Array.isArray) as PackEntry[][];
      let i = 0;
      for (const e of lists.flat()) {
        if (e?.to_email) recipients.push({ key: companyKey(e.to_email), entry: i, type: e.draft_type ?? "" });
        i++;
      }
      c = { mtime: m, recipients, stagedInPack };
      packCache.set(name, c);
    }
    // the sidecar marker is a separate file, so its state is re-read every call
    const stagedTs = c.stagedInPack ?? readSidecarStagedAt(path.join(DRAFTS_DIR, name.replace(/\.json$/, ".staged.json")));
    const sent = packWasSent(name);
    for (const r of c.recipients) {
      const t = touch(r.key);
      t.drafted = { pack: name, entry: r.entry, type: r.type, day: packDay(name, m) };
      t.staged = stagedTs; // latest pack's staging state wins for this recipient
      t.packSent = sent;
    }
  }
  prune(packCache, new Set(packs.map((p) => p.n)));

  // sent: per-recipient send records (recent files only, cheap stat filter)
  const cutoff = Date.now() - 45 * 86400_000;
  const liveSent = new Set<string>();
  for (const name of sentNames) {
    const abs = path.join(SENT_DIR, name);
    const m = statMs(abs);
    if (m < cutoff) continue;
    liveSent.add(name);
    let c = sentCache.get(name);
    if (!c || c.mtime !== m) {
      try {
        const recs = JSON.parse(fs.readFileSync(abs, "utf8")) as { recipient?: string; sent_at_utc?: string }[];
        const kept = Array.isArray(recs)
          ? recs.filter((r) => r?.recipient && r.sent_at_utc).map((r) => ({ key: companyKey(r.recipient as string), at: r.sent_at_utc as string }))
          : [];
        c = { mtime: m, recs: kept };
        sentCache.set(name, c);
      } catch { continue; }
    }
    for (const r of c.recs) {
      const t = touch(r.key);
      if (!t.sent || r.at > t.sent) t.sent = r.at;
    }
  }
  prune(sentCache, liveSent);

  // STALENESS RULE (2026-07-13, Sirius incident): a draft authored before the
  // company's latest real send is history the thread has moved past — offering
  // it as "Draft ready" told the operator to follow up on a month-old meeting.
  // A send on a LATER day than the draft's batch date retires the drafted
  // pointer (day-level so a same-day draft-then-send flow keeps its pending
  // drafts; the pack file stays on disk untouched — only the console stops
  // offering it).
  for (const t of Object.values(j)) {
    if (!t.drafted || !t.sent) continue;
    if (t.sent.slice(0, 10) > t.drafted.day) {
      t.drafted = null;
    }
  }
  return j;
}

// ── staged-marker dual-read (console-side of the fold) ──────────────────────
// "Staged" is moving from a sidecar file (<pack>.staged.json) to a field
// inside the pack itself ({"staged": {"at": <ISO or epoch-ms>, ...}}). Readers
// check the in-pack field FIRST, then fall back to the sidecar — transition
// period, so nothing has to move both places in the same change. Takes the
// already-parsed pack so callers that read the pack anyway don't read twice.
export function readStagedAt(pack: Record<string, unknown> | null | undefined, markPath: string): string | null {
  const inPack = pack && typeof pack.staged === "object" && pack.staged !== null ? (pack.staged as { at?: string | number }) : null;
  if (inPack && inPack.at !== undefined && inPack.at !== null && inPack.at !== "") return String(inPack.at);
  return readSidecarStagedAt(markPath);
}

function readSidecarStagedAt(markPath: string): string | null {
  try {
    if (fs.existsSync(markPath)) {
      return (JSON.parse(fs.readFileSync(markPath, "utf8")) as { ts?: string }).ts ?? "staged";
    }
  } catch { /* fall through to null */ }
  return null;
}

// Null the in-pack `staged` field if present (atomic write: temp file then
// rename). Callers still unlink their own sidecar path separately — this only
// touches the pack JSON.
export function clearStagedField(abs: string): void {
  try {
    if (!fs.existsSync(abs)) return;
    const p = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
    if (!("staged" in p)) return;
    delete p.staged;
    const tmp = `${abs}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2), "utf8");
    fs.renameSync(tmp, abs);
  } catch { /* best-effort */ }
}

export function mtimes() {
  const stat = (p: string) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  let drafts = 0;
  try { for (const n of fs.readdirSync(DRAFTS_DIR)) drafts = Math.max(drafts, stat(path.join(DRAFTS_DIR, n))); } catch { /* none */ }
  return { corpus: stat(CORPUS_PULLS), board: stat(BOARD_FILE), activity: stat(ACTIVITY), drafts };
}
