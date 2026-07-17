import fs from "node:fs";
import path from "node:path";
import { VAULT, TOOLS, PY, run } from "@/lib/vault";
import { markBoardDirty, appendDecision } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gating writes — the durable decisions /inbox-check honors.
//   freeze → append to operator-frozen.json (sticky, survives regen).
//   close  → close_company.py (declined; can auto-reopen on a live signal).
//   dnc    → append to suppression/dnc.jsonl (hard suppression).
// These are deliberate operator actions; the cockpit confirms before calling.
const FROZEN = path.join(VAULT, "pipeline/operator-frozen.json");
const DNC = path.join(VAULT, "suppression/dnc.jsonl");

interface Body {
  action?: "freeze" | "unfreeze" | "close" | "dnc";
  domain?: string;
  email?: string;
  company?: string;
  reason?: string;
  signal?: string;
  // bulk freeze (Pipeline tab): explicit multi-company intent, one registry
  // write, idempotent per entry. Only freeze supports bulk — unfreeze/close/dnc
  // stay one-at-a-time deliberate acts.
  companies?: { domain: string; company?: string; email?: string }[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Body;
  const reason = (b.reason ?? "").trim();
  if (!reason) return Response.json({ error: "reason required" }, { status: 400 });

  if (b.action === "freeze") {
    const targets = Array.isArray(b.companies) && b.companies.length > 0
      ? b.companies.filter((c) => c && typeof c.domain === "string" && c.domain)
      : b.domain || b.email
        ? [{ domain: b.domain ?? "", company: b.company, email: b.email }]
        : [];
    if (targets.length === 0) return Response.json({ error: "domain or email required" }, { status: 400 });
    let reg: { _meta?: unknown; frozen?: Record<string, unknown>[] };
    try {
      reg = JSON.parse(fs.readFileSync(FROZEN, "utf8"));
    } catch {
      reg = { frozen: [] };
    }
    reg.frozen = reg.frozen ?? [];
    // idempotent per entry: skip any domain/email already frozen
    let added = 0, already = 0;
    for (const t of targets) {
      const dup = reg.frozen.some(
        (f) => (t.domain && f.domain === t.domain) || (t.email && f.email === t.email),
      );
      if (dup) { already++; continue; }
      reg.frozen.push({
        company: t.company ?? t.domain ?? t.email ?? "",
        domain: t.domain ?? "",
        email: t.email ?? "",
        reason,
        frozen_on: today(),
        by: "operator (cockpit)",
      });
      added++;
    }
    if (added > 0) {
      fs.writeFileSync(FROZEN, JSON.stringify(reg, null, 1));
      markBoardDirty("freeze");
      for (const t of targets) appendDecision(t.domain || t.email || "", "freeze", reason, "operator (cockpit)");
    }
    return Response.json({ ok: true, action: "freeze", added, already: already > 0 ? already : targets.length === 1 && added === 0, count: reg.frozen.length });
  }

  if (b.action === "unfreeze") {
    // reverse a freeze: drop the registry entry; the company returns to the
    // worklists on the next board regen (marked dirty below). Recorded in the
    // activity log like every operator decision.
    if (!b.domain && !b.email) return Response.json({ error: "domain or email required" }, { status: 400 });
    let reg: { _meta?: unknown; frozen?: Record<string, unknown>[] };
    try {
      reg = JSON.parse(fs.readFileSync(FROZEN, "utf8"));
    } catch {
      reg = { frozen: [] };
    }
    reg.frozen = reg.frozen ?? [];
    const before = reg.frozen.length;
    reg.frozen = reg.frozen.filter((f) => {
      const dom = String(f.domain ?? ""); const em = String(f.email ?? "");
      if (b.domain && (dom === b.domain || em.endsWith("@" + b.domain) || String(f.company ?? "") === b.domain)) return false;
      if (b.email && em === b.email) return false;
      return true;
    });
    const removed = before - reg.frozen.length;
    if (removed > 0) {
      fs.writeFileSync(FROZEN, JSON.stringify(reg, null, 1));
      appendDecision(b.domain ?? b.email ?? "", "unfreeze", reason, "operator (cockpit)");
      markBoardDirty("unfreeze");
    }
    return Response.json({ ok: true, action: "unfreeze", removed, count: reg.frozen.length });
  }

  if (b.action === "close") {
    if (!b.domain && !b.email) return Response.json({ error: "domain or email required" }, { status: 400 });
    const args = [path.join(TOOLS, "close_company.py"), "--reason", reason, "--by", "operator (cockpit)"];
    if (b.domain) args.push("--domain", b.domain);
    if (b.email) args.push("--email", b.email);
    if (b.company) args.push("--company", b.company);
    if (b.signal) args.push("--signal", b.signal);
    const r = await run(PY, args, { cwd: TOOLS, timeout: 30_000 });
    if (r.code !== 0) return Response.json({ ok: false, error: r.stderr.slice(-400) }, { status: 502 });
    markBoardDirty("close");
    return Response.json({ ok: true, action: "close", out: r.stdout.slice(-400) });
  }

  if (b.action === "dnc") {
    if (!b.email) return Response.json({ error: "email required" }, { status: 400 });
    const line =
      JSON.stringify({
        email: b.email,
        domain: b.domain ?? b.email.split("@")[1] ?? "",
        reason,
        channel: "operator",
        ts: new Date().toISOString(),
      }) + "\n";
    fs.appendFileSync(DNC, line);
    markBoardDirty("dnc");
    return Response.json({ ok: true, action: "dnc" });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
