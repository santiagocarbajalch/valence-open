import fs from "node:fs";
import path from "node:path";
import { safeUnder } from "@/lib/vault";
import { fixture } from "@/lib/fixtures";
import { DRAFTS_DIR, SENT_DIR, companyKey, readStagedAt } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PackEntry {
  to_email?: string;
  to_name?: string;
  institution?: string;
  draft_type?: string;
  subject?: string;
  body?: string;
  attachments?: string[];
  _thread?: string;
  in_reply_to?: string | null;
  cc?: string;
  country?: string;
  lang?: string;
}
interface Pack {
  date?: string;
  batch_label?: string;
  status?: string;
  note?: string;
  drafts?: PackEntry[];
  [k: string]: unknown;
}

// Packs store the draft list under one or more list-valued keys (usually "drafts").
function entriesOf(p: Pack): PackEntry[] {
  const out: PackEntry[] = [];
  for (const v of Object.values(p)) if (Array.isArray(v)) out.push(...(v as PackEntry[]));
  return out;
}

// Walk the pack's list-valued keys to the entry at flat index `i` and mutate it.
function editEntry(p: Pack, i: number, patch: Partial<PackEntry>): boolean {
  let n = 0;
  for (const v of Object.values(p)) {
    if (!Array.isArray(v)) continue;
    for (const e of v as PackEntry[]) {
      if (n === i) { Object.assign(e, patch); return true; }
      n++;
    }
  }
  return false;
}

// Resolve the entry to edit. The client's flat index goes stale the moment a
// pack is split/purged behind it (the "entry out of range" audit bug), so the
// recipient email is the PRIMARY selector when it identifies exactly one entry;
// the index is the fallback (and the tiebreak when one recipient appears twice).
function resolveEntry(p: Pack, i: number, email: string | null): PackEntry | null {
  const all = entriesOf(p);
  if (email) {
    const hits = all.filter((e) => (e.to_email ?? "").toLowerCase() === email);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1 && all[i] && (all[i].to_email ?? "").toLowerCase() === email) return all[i];
    if (hits.length > 1) return hits[0];
    return null; // recipient no longer in this pack — stale card
  }
  return all[i] ?? null;
}

// POST /api/drafts { file, entry, subject?, body?, to_email?, to_name? } — inline draft edit.
// Writes the base pack (and the .threaded.json twin if present) atomically and
// CLEARS staged state (nulls the in-pack `staged` field + unlinks the sidecar,
// transition period — see lib/pipeline.ts): an edited pack must be re-staged before send.
// Recipient edits (V4.1 Phase 6) are SAME-COMPANY only, enforced server-side:
// to_email is the draft's identity join key (companyKey → journey/board row), so
// a cross-company change would silently re-home the draft. On a recipient change
// the stale .threaded.json twin is deleted — the stage gate chain re-recovers
// threading for the new contact from the Sent box.
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { file?: string; entry?: number; subject?: string; body?: string; to_email?: string; to_name?: string; original_to?: string };
  if (!b.file || typeof b.entry !== "number") return Response.json({ error: "need file + entry" }, { status: 400 });
  const originalTo = typeof b.original_to === "string" && b.original_to.includes("@") ? b.original_to.toLowerCase().trim() : null;
  const patch: Partial<PackEntry> = {};
  if (typeof b.subject === "string") patch.subject = b.subject;
  if (typeof b.body === "string") patch.body = b.body;
  const wantsRecipient = typeof b.to_email === "string" && b.to_email.includes("@");
  if (!Object.keys(patch).length && !wantsRecipient) return Response.json({ error: "nothing to change" }, { status: 400 });

  const abs = safeUnder(DRAFTS_DIR, b.file);
  if (!abs || !fs.existsSync(abs) || abs.endsWith(".staged.json")) return Response.json({ error: "bad pack" }, { status: 400 });

  let recipientChanged = false;
  if (wantsRecipient) {
    try {
      const p = JSON.parse(fs.readFileSync(abs, "utf8")) as Pack;
      const cur = resolveEntry(p, b.entry, originalTo);
      if (!cur) return Response.json({ error: "That draft isn't in this pack anymore — it was probably reorganized. Refresh and open it again." }, { status: 409 });
      const curEmail = (cur.to_email ?? "").toLowerCase();
      const nextEmail = b.to_email!.toLowerCase().trim();
      if (nextEmail !== curEmail) {
        if (companyKey(nextEmail) !== companyKey(curEmail)) {
          return Response.json({
            error: `${b.to_email} is a different company than ${cur.to_email} — recipient changes stay inside the same company. For a different company, delete this draft and draft at the right contact.`,
          }, { status: 409 });
        }
        patch.to_email = nextEmail;
        if (typeof b.to_name === "string") patch.to_name = b.to_name;
        patch._thread = "pending";       // threading must be re-recovered for the new contact
        patch.in_reply_to = null;
        recipientChanged = true;
      } else if (typeof b.to_name === "string" && b.to_name !== cur.to_name) {
        patch.to_name = b.to_name;
      }
    } catch {
      return Response.json({ error: "pack unreadable" }, { status: 500 });
    }
    if (!Object.keys(patch).length) return Response.json({ error: "nothing to change" }, { status: 400 });
  }

  const threaded = abs.endsWith(".threaded.json") ? null : abs.replace(/\.json$/, ".threaded.json");
  const targets = [abs];
  if (threaded && fs.existsSync(threaded) && !recipientChanged) targets.push(threaded);
  for (const t of targets) {
    try {
      const p = JSON.parse(fs.readFileSync(t, "utf8")) as Pack;
      // prefer the recipient as selector — the twin's entry order can differ
      // from the base pack, and the client's index can be stale (see resolveEntry)
      const target = resolveEntry(p, b.entry, originalTo);
      if (target) Object.assign(target, patch);
      else if (!editEntry(p, b.entry, patch))
        return Response.json({ error: "That draft isn't in this pack anymore — it was probably reorganized. Refresh and open it again." }, { status: 409 });
      delete p.staged; // in-pack half of the staged clear (sidecar unlinked below)
      const tmp = `${t}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(p, null, 2), "utf8");
      fs.renameSync(tmp, t);
    } catch {
      return Response.json({ error: `write failed: ${path.basename(t)}` }, { status: 500 });
    }
  }
  if (recipientChanged && threaded) {
    try { fs.unlinkSync(threaded); } catch { /* no twin */ }
  }
  const mark = abs.replace(/(\.threaded)?\.json$/, ".staged.json");
  try { fs.unlinkSync(mark); } catch { /* was not staged */ }
  return Response.json({ ok: true, restageRequired: true, recipientChanged });
}

// ONE row per logical pack: the base .json is the unit; .threaded.json and
// .staged.json are folded in as state, never listed as separate packs.
// staged truth = the durable .staged.json marker written by cockpit_stage.sh
// (legacy fallback: every entry carrying a _thread verdict).
// sent truth = a matching per-recipient record file in pipeline/sent/.
export async function GET(req: Request) {
  const file = new URL(req.url).searchParams.get("file");
  // fixtures: a single-pack read has its own pack-shaped fixture (the packs-list
  // fixture is the wrong shape for it) — lets the smoke walk the group-send modal
  if (file) {
    const fp = fixture("drafts-pack");
    if (fp) return Response.json(fp);
  }
  const fx = fixture("drafts");
  if (fx) return Response.json(fx);

  if (file) {
    const abs = safeUnder(DRAFTS_DIR, file);
    if (!abs) return Response.json({ error: "bad path" }, { status: 403 });
    try {
      const content = fs.readFileSync(abs, "utf8");
      return Response.json({ file, pack: JSON.parse(content), mtime: fs.statSync(abs).mtimeMs });
    } catch {
      return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(DRAFTS_DIR).filter(
      (n) => n.endsWith(".json") && !n.endsWith(".threaded.json") && !n.endsWith(".staged.json"),
    );
  } catch {
    return Response.json({ packs: [] });
  }

  let sentBases = new Set<string>();
  try {
    sentBases = new Set(fs.readdirSync(SENT_DIR).map((n) => n.replace(/\.json$/, "")));
  } catch { /* none */ }

  const packs = names
    .map((name) => {
      const abs = path.join(DRAFTS_DIR, name);
      const base = name.replace(/\.json$/, "");
      try {
        const p = JSON.parse(fs.readFileSync(abs, "utf8")) as Pack;
        const es = entriesOf(p);
        const threadedFile = path.join(DRAFTS_DIR, `${base}.threaded.json`);
        const stagedFile = path.join(DRAFTS_DIR, `${base}.staged.json`);
        const stagedAt = readStagedAt(p, stagedFile);
        // ONE truth for "staged": the in-pack `staged` field, falling back to
        // the .staged.json marker (transition period). The old thread-verdict
        // heuristic is retired — backfill_staged_markers.py wrote real markers
        // for legacy packs verified against the live Gmail Drafts box.
        // sent record files carry the batch/pack base in their name
        const sent = [...sentBases].some((s) => s.includes(base) || base.includes(s.replace(/^\d{4}-\d{2}-\d{2}-/, "")));
        return {
          file: name,
          label: p.batch_label ?? base,
          date: p.date ?? null,
          status: p.status ?? null,
          note: p.note ?? null,
          count: es.length,
          types: Array.from(new Set(es.map((e) => e.draft_type).filter(Boolean))),
          recipients: es.map((e) => e.to_email).filter(Boolean),
          withAttachments: es.filter((e) => (e.attachments?.length ?? 0) > 0).length,
          threaded: fs.existsSync(threadedFile),
          staged: !!stagedAt,
          stagedAt,
          sent,
          mtime: fs.statSync(abs).mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b!.mtime ?? 0) - (a!.mtime ?? 0));

  return Response.json({ packs });
}
