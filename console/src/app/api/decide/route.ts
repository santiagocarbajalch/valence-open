import { appendDecision, companyKey, readDecisions } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator triage decisions — the Decide stage's durable write. Appends a
// kind:"decision" event to lead_activity.jsonl (the SAME log /inbox-check and
// company_state read), so the day's triage survives reloads and is auditable.
// Latest decision per company per day wins on read-back.

const ALLOWED = new Set(["reply", "skip", "needs-info", "include", "clear"]);

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { domain?: string; decision?: string; detail?: string };
  // Normalize through the SAME companyKey deriveJourneys uses (corporate email →
  // registrable domain; freemail → full mailbox) so a decision made on an email
  // address and the journey derived from the pack's to_email land on ONE key.
  const domain = companyKey((body.domain ?? "").trim().toLowerCase());
  const decision = (body.decision ?? "").trim();
  if (!domain || !ALLOWED.has(decision)) {
    return Response.json({ error: `need domain + decision (${[...ALLOWED].join("/")})` }, { status: 400 });
  }
  const rec = appendDecision(domain, decision, body.detail?.trim() || undefined);
  return Response.json({ ok: true, rec });
}

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  return Response.json({ decisions: readDecisions(today) });
}
