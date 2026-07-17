import path from "node:path";
import fs from "node:fs";
import { VAULT, TOOLS, PY, safeUnder, run } from "@/lib/vault";
import { companyKey, clearStagedField, humanPackName } from "@/lib/pipeline";
import { startJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DRAFTS_DIR = path.join(VAULT, "pipeline/drafts");
const COLD_TYPES = /^COLD/i;

// POST /api/stage { file } → run the gate chain detached, return a jobId to poll.
// Stages into the Gmail Drafts box only — NEVER sends.
// V4.1 guards: staging is refused for frozen/closed recipients (freeze and
// drafting are mutually enforced), and a WARM pack must be one company — the
// pack is the staging unit, so a multi-company warm pack would silently stage
// other companies' mail (the Staged 0→5 audit bug).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { file?: string };
  const file = body.file ?? "";
  const abs = safeUnder(DRAFTS_DIR, file);
  if (!abs || !fs.existsSync(abs)) return Response.json({ error: "bad pack" }, { status: 400 });

  let entries: { to_email?: string; draft_type?: string }[] = [];
  try {
    const pack = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
    entries = (Object.values(pack).filter(Array.isArray) as { to_email?: string; draft_type?: string }[][]).flat();
  } catch {
    return Response.json({ error: "pack unreadable" }, { status: 400 });
  }

  const warm = entries.filter((e) => e?.draft_type && !COLD_TYPES.test(e.draft_type));
  const warmCompanies = new Set(warm.map((e) => companyKey(e.to_email ?? "")));
  let stageTargets = [abs];
  let splitCount = 0;
  if (warm.length > 0 && warmCompanies.size > 1) {
    // A multi-company warm bundle can't stage as one unit (the Staged 0→5 audit
    // bug) — but that's OUR housekeeping, not the operator's. Split it into
    // per-company packs right here (split_pack.py) and stage each one.
    const sp = await run(PY, [path.join(TOOLS, "split_pack.py"), "--pack", abs], { cwd: "/opt/velab/workspace", timeout: 30_000 });
    if (sp.code !== 0) {
      const detail = (sp.stderr + sp.stdout).includes("console-approvals")
        ? "a send is already in progress from this bundle"
        : "it couldn't be reorganized automatically";
      return Response.json({
        error: `This bundle holds replies for ${warmCompanies.size} different companies, and ${detail}. Nothing was staged — try again in a minute, or draft the day again to get fresh per-company drafts.`,
      }, { status: 409 });
    }
    // children the split wrote ("write <name>.json …") or found already written
    const kids = new Set<string>();
    for (const line of sp.stdout.split("\n")) {
      const w = line.match(/^write (\S+\.json)/);
      const s = line.match(/^⚠ (\S+\.json) exists — skipping/);
      const name = w?.[1] ?? s?.[1];
      if (name && !name.endsWith(".threaded.json") && !name.endsWith(".staged.json")) kids.add(name);
    }
    stageTargets = [...kids].map((n) => path.join(DRAFTS_DIR, n)).filter((p) => fs.existsSync(p));
    if (!stageTargets.length) {
      return Response.json({ error: "The bundle was reorganized into per-company drafts, but none were found to stage — open Drafts and stage them individually." }, { status: 500 });
    }
    // a split child inherits the parent's staged marker; clear it so the gate
    // chain runs fresh for each child (an unstaged child must never look staged).
    // Transition period (lib/pipeline.ts): null the in-pack field AND unlink
    // the sidecar, so neither reader is left thinking the child is staged.
    for (const t of stageTargets) {
      clearStagedField(t);
      try { fs.unlinkSync(t.replace(/\.json$/, ".staged.json")); } catch { /* none */ }
    }
    splitCount = stageTargets.length;
  }

  const gate = gatedRecipients(entries);
  if (gate.length > 0) {
    return Response.json({
      error: `${gate.join(", ")} ${gate.length === 1 ? "is" : "are"} paused or closed — reactivate from System status before staging mail to ${gate.length === 1 ? "it" : "them"}.`,
    }, { status: 409 });
  }

  // one job stages every target in sequence (usually just one)
  const script = stageTargets.map((t) => `${JSON.stringify(path.join(TOOLS, "cockpit_stage.sh"))} ${JSON.stringify(t)}`).join(" && ");
  const jobId = startJob({
    label: "stage",
    argv: ["/bin/bash", "-c", script],
    cwd: "/opt/velab/workspace",
    context: {
      kind: "stage",
      title: `Safety checks on ${entries.length} draft${entries.length === 1 ? "" : "s"} — ${humanPackName(file)}`,
      packFile: file,
      total: entries.length,
      view: "cockpit",
    },
  });
  return Response.json({ jobId, split: splitCount || undefined });
}

function gatedRecipients(entries: { to_email?: string }[]): string[] {
  const keys = new Set(entries.map((e) => companyKey(e.to_email ?? "")).filter(Boolean));
  const gated = new Set<string>();
  try {
    const f = JSON.parse(fs.readFileSync(path.join(VAULT, "pipeline/operator-frozen.json"), "utf8")) as { frozen?: { domain?: string; email?: string }[] };
    for (const e of f.frozen ?? []) { const k = companyKey(e.email || e.domain || ""); if (keys.has(k)) gated.add(k); }
  } catch { /* no registry */ }
  try {
    const c = JSON.parse(fs.readFileSync(path.join(VAULT, "pipeline/closed.json"), "utf8")) as { closed?: unknown };
    const rows = (c.closed ?? c) as Record<string, unknown> | { domain?: string }[];
    const doms = Array.isArray(rows) ? rows.map((e) => e?.domain ?? "") : Object.keys(rows);
    for (const d of doms) { const k = companyKey(String(d)); if (keys.has(k)) gated.add(k); }
  } catch { /* no registry */ }
  return [...gated];
}
