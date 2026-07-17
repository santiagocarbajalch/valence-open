import fs from "node:fs";
import { run, PY } from "@/lib/vault";
import { fixture } from "@/lib/fixtures";
import { readDecisions, deriveJourneys, mtimes, BOARD_FILE, boardIsDirty, markBoardDirty } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The certified company-truth board — PARITY REBUILD 2026-07-03.
//
// The cockpit no longer derives ANY presentation from board.json. It consumes
// the CANONICAL VIEW that core/render_board.py builds — the same build_view()
// whose markdown serialization /inbox-check prints. Sections, row cells, action
// strings, cert lines: identical by construction on both surfaces.
//
//   • the engine (truth.py + certify.py) re-runs ONLY when board.json is older
//     than 5 minutes; otherwise this is a pure local read (~ms, zero IMAP);
//   • render_board.py --json emits the view verbatim — this route adds ONLY the
//     write-layer: today's operator decisions (lead_activity.jsonl), the
//     drafted→staged→sent journeys, and file mtimes for the 30s head poll;
//   • ?head=1 returns just file mtimes — the client's cheap new-mail poll.

const CORE = "/opt/velab/core";
const MAX_AGE_MS = 5 * 60_000;

// One regen at a time. Two simultaneous GETs used to race: one re-ran the
// engine while the other read board.json BETWEEN truth.py's write and
// certify.py's cert block — and the UI flashed "NOT CERTIFIED" with nothing
// actually wrong (Chrome audit 2026-07-10, flip on reload). Concurrent
// requests now await the same regen.
let regenInFlight: Promise<string | null> | null = null;
async function regenerate(): Promise<string | null> {
  if (!regenInFlight) {
    regenInFlight = (async () => {
      try {
        const t = await run(PY, ["truth.py"], { cwd: CORE, timeout: 90_000 });
        if (t.code !== 0) return t.stderr.slice(-400);
        const c = await run(PY, ["certify.py"], { cwd: CORE, timeout: 90_000 });
        if (c.code !== 0) return c.stderr.slice(-400);
        // the Auditor: refresh audit.json for this view. Its non-zero exit means
        // a data-integrity ALERT (surfaced in the view's `audit` banner), NOT an
        // engine failure — never treat it as a regen error or the board would
        // 502 exactly when the operator most needs to see the alert.
        await run(PY, ["auditor.py"], { cwd: CORE, timeout: 90_000 });
        return null;
      } finally {
        regenInFlight = null;
      }
    })();
  }
  return regenInFlight;
}

// POST = pull-then-dirty: refresh today's corpus from Gmail NOW and mark the
// board for regeneration. The client calls this right after a send job
// finishes so the very next board load already reflects the sent mail —
// no waiting on the 5-min corpus timer. Truth source unchanged: the pull
// reads Gmail (Enviados included); nothing is synthesized.
export async function POST() {
  if (fixture("board")) return Response.json({ ok: true, fixture: true });
  const TOOLS = "/opt/velab/workspace/tools";
  const r = await run(PY, ["corpus_pull.py", "--mode", "today"], { cwd: TOOLS, timeout: 90_000 });
  if (r.code !== 0) return Response.json({ ok: false, error: r.stderr.slice(-300) }, { status: 502 });
  markBoardDirty("send:refresh");
  return Response.json({ ok: true });
}

export async function GET(req: Request) {
  // fixtures mode (§11.1): serve the frozen test day, never run the engine
  const fx = fixture("board");
  if (fx) return Response.json(fx);

  // cheap freshness head for the 30s client poll — no engine run, no IMAP
  if (new URL(req.url).searchParams.get("head")) return Response.json({ mtimes: mtimes() });

  // regenerate + certify when the persisted board is stale (>5 min), when a
  // registry mutation marked it dirty, or when the client forces after a write.
  // Rapid-mutation guard: a board younger than 5s is never re-run for plain
  // force/stale. DIRTY is exempt (audit 2026-07-10): a registry mutation changed
  // engine-visible state, and the guard swallowing it left the operator staring
  // at a pre-mutation board after a success toast until a manual reload.
  const force = new URL(req.url).searchParams.get("force") === "1";
  let ageMs = Infinity;
  try { ageMs = Date.now() - fs.statSync(BOARD_FILE).mtimeMs; } catch { /* absent → regenerate */ }
  let engineErr: string | null = null;
  const regenReason = boardIsDirty() ? "dirty"
    : ageMs <= 5_000 ? null
    : force ? "force"
    : ageMs > MAX_AGE_MS ? "stale"
    : null;
  if (regenReason) engineErr = await regenerate();
  else if (regenInFlight) await regenInFlight; // a regen is mid-write — read AFTER it settles, never between truth and certify

  // the canonical view — the exact object /inbox-check's markdown is printed from
  const v = await run(PY, ["render_board.py", "--json"], { cwd: CORE, timeout: 30_000 });
  let view: Record<string, unknown>;
  try {
    view = JSON.parse(v.stdout);
  } catch {
    return Response.json(
      { error: "canonical view unavailable", detail: v.stderr.slice(-400), engineErr, certified: false },
      { status: 502 },
    );
  }

  const meta = (view.meta ?? {}) as { today?: string };
  const today = meta.today ?? new Date().toISOString().slice(0, 10);

  // A ready-to-send draft must reflect a FULL read of the thread (operator
  // ruling 2026-07-13, Sirius incident): a draft authored before the client's
  // last message cannot have read that message — retire its pointer here,
  // where the board rows know the last inbound. (Drafts older than our own
  // latest send are already retired inside deriveJourneys.)
  const journeys = deriveJourneys();
  const companies = (view.companies ?? []) as { key?: string; last_in_date?: string }[];
  for (const row of companies) {
    const t = row.key ? journeys[row.key] : undefined;
    if (!t?.drafted?.day || !row.last_in_date) continue;
    if (row.last_in_date.slice(0, 10) > t.drafted.day) t.drafted = null;
  }

  return Response.json({
    ranAt: Date.now(),
    engineErr,
    regenerated: !!regenReason && !engineErr,
    regenReason,
    view,
    decisions: readDecisions(today),
    journeys,
    mtimes: mtimes(),
  });
}
