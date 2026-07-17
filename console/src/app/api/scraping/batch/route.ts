import fs from "node:fs";
import path from "node:path";
import { VAULT } from "@/lib/vault";
import { fixture, fixturesOn } from "@/lib/fixtures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One landed batch, opened up — the companies and contacts inside, each marked
// whether the send ledger has already seen its address (same ledger join as the
// fresh-pool and history counts). Read-only.

const VERIFIED_DIR = path.join(VAULT, "leads/verified");
const LEDGER = path.join(VAULT, "pipeline/cadence/ledger.json");
const BATCH_NAME = /^[\w.-]+\.json$/;

interface VLead { institution?: string; email?: string; phone?: string; country?: string; contact_name?: string; title?: string }

export async function GET(req: Request) {
  if (fixturesOn()) return Response.json(fixture("scraping-batch") ?? { leads: [] });
  const name = new URL(req.url).searchParams.get("file") ?? "";
  if (!BATCH_NAME.test(name) || name.includes("..")) return Response.json({ error: "bad batch" }, { status: 400 });
  const abs = path.join(VERIFIED_DIR, name);
  let batch: { leads?: VLead[] };
  try { batch = JSON.parse(fs.readFileSync(abs, "utf8")); } catch { return Response.json({ error: "batch not found" }, { status: 404 }); }

  const contacted = new Set<string>();
  try {
    const led = JSON.parse(fs.readFileSync(LEDGER, "utf8")) as { leads?: { email?: string }[] };
    for (const l of led.leads ?? []) if (l.email) contacted.add(l.email.toLowerCase());
  } catch { /* ledger optional */ }

  return Response.json({
    leads: (batch.leads ?? []).map((l) => ({
      institution: l.institution ?? "",
      email: l.email ?? "",
      contactName: l.contact_name ?? "",
      title: l.title ?? "",
      phone: l.phone ?? "",
      country: l.country ?? "",
      emailed: Boolean(l.email && contacted.has(l.email.toLowerCase())),
    })),
  });
}
