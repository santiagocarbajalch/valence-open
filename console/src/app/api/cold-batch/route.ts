import fs from "node:fs";
import path from "node:path";
import { VAULT, TOOLS, PY, run } from "@/lib/vault";
import { fixture, fixturesOn } from "@/lib/fixtures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cold batch groups — the "Cold outreach due" list's send-all machinery.
//
// GET  → the variant plan (language × ladder step → companies) straight from
//        gen_cold_pack.py --plan, which applies the SAME noise/unresolved
//        filters and language/step choices as real pack generation — the
//        console never re-derives grouping logic (parity rule).
// POST → write ONE single-variant pack for a chosen group. The pack then rides
//        the EXISTING path unchanged: /api/stage (full gate chain) →
//        SendModal → /api/send (guardrail → grant → paced sender). This route
//        writes a draft file and nothing else — it cannot send.

const GEN = path.join(TOOLS, "gen_cold_pack.py");
const BOARD = path.join(VAULT, "state/board.json");
const DRAFTS_DIR = path.join(VAULT, "pipeline/drafts");

const EMPTY = { as_of: "", cold_due: 0, groups: [], dropped_noise: [], unresolved_no_send_on_record: [] };

// the plan walks the whole sent corpus (~seconds) — cache it per board build
let planCache: { boardMtime: number; data: unknown } | null = null;

export async function GET() {
  if (fixturesOn()) return Response.json(fixture("cold-batch") ?? EMPTY);
  let boardMtime = 0;
  try { boardMtime = fs.statSync(BOARD).mtimeMs; } catch { return Response.json(EMPTY); }
  if (planCache && planCache.boardMtime === boardMtime) return Response.json(planCache.data);
  const r = await run(PY, [GEN, "--plan"], { cwd: TOOLS, timeout: 120_000 });
  if (r.code !== 0) return Response.json({ error: r.stderr.slice(-400) || "plan failed" }, { status: 502 });
  try {
    const data = JSON.parse(r.stdout);
    planCache = { boardMtime, data };
    return Response.json(data);
  } catch {
    return Response.json({ error: "plan output unreadable" }, { status: 502 });
  }
}

interface PackEntry { _revisions?: unknown[] }

// entries of today's already-written pack for a group, or null if none exists
function todaysPack(lang: string, step: string): { file: string; entries: PackEntry[] } | null {
  // the generator stamps AS_OF with the machine's local date — match it, not UTC
  const today = new Date().toLocaleDateString("en-CA");
  const file = `${today}__cold-followups__${lang}__${step}.json`;
  try {
    const pack = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, file), "utf8")) as Record<string, unknown>;
    return { file, entries: (Object.values(pack).filter(Array.isArray) as PackEntry[][]).flat() };
  } catch { return null; }
}

export async function POST(req: Request) {
  // fixtures serve a frozen day — nothing may touch the live drafts dir
  if (fixturesOn()) {
    const fx = fixture("cold-batch-post");
    return fx ? Response.json(fx) : Response.json({ error: "fixtures mode — no drafts are written" }, { status: 503 });
  }
  const b = (await req.json().catch(() => ({}))) as { lang?: string; step?: string; fresh?: boolean };
  const lang = b.lang ?? "", step = b.step ?? "";
  if (!["english", "spanish"].includes(lang) || !["cold-02", "cold-03"].includes(step)) {
    return Response.json({ error: "bad group" }, { status: 400 });
  }
  // a pack the operator already rewrote today is HIS work — regenerating would
  // silently clobber it (doctrine tenet 16). Reuse it unless he asks for fresh.
  if (!b.fresh) {
    const kept = todaysPack(lang, step);
    if (kept && kept.entries.length > 0 && kept.entries.some((e) => (e._revisions?.length ?? 0) > 0)) {
      return Response.json({ ok: true, file: kept.file, count: kept.entries.length, revisedKept: true });
    }
  }
  const r = await run(PY, [GEN, "--lang", lang, "--step", step], { cwd: TOOLS, timeout: 120_000 });
  if (r.code !== 0) return Response.json({ error: r.stderr.slice(-400) || "generation failed" }, { status: 502 });
  const m = r.stdout.match(/wrote (\S+\.json)\s+\((\d+) drafts\)/);
  if (!m) return Response.json({ error: "generator reported no pack" }, { status: 502 });
  const abs = m[1], count = Number(m[2]);
  const file = path.basename(abs);
  if (count === 0) {
    // the group emptied between plan and click (replies landed, freezes, a
    // board rebuild) — honest refusal, and don't leave an empty pack behind
    try { fs.unlinkSync(abs); } catch { /* already gone */ }
    return Response.json({ error: "Nobody is due in that group any more — refresh the board." }, { status: 409 });
  }
  // the base pack was just rewritten — twins from an earlier run of the same
  // day are stale; the gate chain must run fresh on this content
  for (const suffix of [".threaded.json", ".staged.json"]) {
    try { fs.unlinkSync(path.join(DRAFTS_DIR, file.replace(/\.json$/, suffix))); } catch { /* none */ }
  }
  return Response.json({ ok: true, file, count });
}
