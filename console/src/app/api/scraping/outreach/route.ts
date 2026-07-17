import fs from "node:fs";
import path from "node:path";
import { VAULT, TOOLS, PY, run } from "@/lib/vault";
import { fixture, fixturesOn } from "@/lib/fixtures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cold first-touch opens for a landed scraping batch — the Scraping tab's
// "email the fresh ones" machinery (operator decision 2026-07-12: first opens
// live on the scraping surface; follow-ups stay in Today via /api/cold-batch).
//
// GET  ?batch=<verified file> → the open plan (who is fresh, grouped by
//        language) straight from gen_cold_open_pack.py --plan, which applies
//        the SAME already-contacted / do-not-contact / one-per-company filters
//        as real pack generation — the console never re-derives them (parity).
// POST → write ONE single-language opener pack. The pack then rides the
//        EXISTING path unchanged: /api/stage (full gate chain) → SendModal →
//        /api/send (guardrail → grant → paced sender). This route writes a
//        draft file and nothing else — it cannot send.

const GEN = path.join(TOOLS, "gen_cold_open_pack.py");
const VERIFIED_DIR = path.join(VAULT, "leads/verified");
const DRAFTS_DIR = path.join(VAULT, "pipeline/drafts");

const BATCH_NAME = /^[\w.-]+\.json$/;

function safeBatch(name: string): string | null {
  if (!BATCH_NAME.test(name) || name.includes("..")) return null;
  return fs.existsSync(path.join(VERIFIED_DIR, name)) ? name : null;
}

export async function GET(req: Request) {
  if (fixturesOn()) return Response.json(fixture("scraping-outreach") ?? { openable: 0, groups: [], skipped: {} });
  const batch = safeBatch(new URL(req.url).searchParams.get("batch") ?? "");
  if (!batch) return Response.json({ error: "bad batch" }, { status: 400 });
  const r = await run(PY, [GEN, "--batch", batch, "--plan"], { cwd: TOOLS, timeout: 60_000 });
  if (r.code !== 0) return Response.json({ error: r.stderr.slice(-400) || "plan failed" }, { status: 502 });
  try {
    return Response.json(JSON.parse(r.stdout));
  } catch {
    return Response.json({ error: "plan output unreadable" }, { status: 502 });
  }
}

interface PackEntry { _revisions?: unknown[] }

// today's already-written opener pack for this batch+language, or null
function todaysPack(batch: string, lang: string): { file: string; entries: PackEntry[] } | null {
  const today = new Date().toLocaleDateString("en-CA"); // generator stamps local date
  const file = `${today}__cold-opens__${lang}__${batch.replace(/\.json$/, "")}.json`;
  try {
    const pack = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, file), "utf8")) as Record<string, unknown>;
    return { file, entries: (Object.values(pack).filter(Array.isArray) as PackEntry[][]).flat() };
  } catch { return null; }
}

export async function POST(req: Request) {
  // fixtures serve a frozen day — nothing may touch the live drafts dir
  if (fixturesOn()) {
    const fx = fixture("scraping-outreach-post");
    return fx ? Response.json(fx) : Response.json({ error: "fixtures mode — no drafts are written" }, { status: 503 });
  }
  const b = (await req.json().catch(() => ({}))) as { batch?: string; lang?: string; fresh?: boolean };
  const batch = safeBatch(b.batch ?? "");
  const lang = b.lang ?? "";
  if (!batch || !["english", "spanish"].includes(lang)) {
    return Response.json({ error: "bad batch or language" }, { status: 400 });
  }
  // a pack the operator already rewrote today is HIS work — regenerating would
  // silently clobber it (doctrine tenet 16). Reuse it unless he asks for fresh.
  if (!b.fresh) {
    const kept = todaysPack(batch, lang);
    if (kept && kept.entries.length > 0 && kept.entries.some((e) => (e._revisions?.length ?? 0) > 0)) {
      return Response.json({ ok: true, file: kept.file, count: kept.entries.length, revisedKept: true });
    }
  }
  const r = await run(PY, [GEN, "--batch", batch, "--lang", lang], { cwd: TOOLS, timeout: 60_000 });
  if (r.code !== 0) return Response.json({ error: r.stderr.slice(-400) || "generation failed" }, { status: 502 });
  const m = r.stdout.match(/wrote (\S+\.json) \((\d+) drafts\)/);
  if (!m) return Response.json({ error: "generator reported no pack" }, { status: 502 });
  const abs = m[1], count = Number(m[2]);
  const file = path.basename(abs);
  if (count === 0) {
    // everyone fresh in this language got contacted between plan and click
    try { fs.unlinkSync(abs); } catch { /* already gone */ }
    return Response.json({ error: "Nobody in that batch is still uncontacted in this language — refresh and check again." }, { status: 409 });
  }
  // the base pack was just rewritten — twins from an earlier run of the same
  // day are stale; the gate chain must run fresh on this content
  for (const suffix of [".threaded.json", ".staged.json"]) {
    try { fs.unlinkSync(path.join(DRAFTS_DIR, file.replace(/\.json$/, suffix))); } catch { /* none */ }
  }
  return Response.json({ ok: true, file, count });
}
