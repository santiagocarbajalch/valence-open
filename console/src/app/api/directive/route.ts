import fs from "node:fs";
import path from "node:path";
import { VAULT } from "@/lib/vault";
import { markBoardDirty, companyKey } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator directives (V4.2) — the registry the ENGINE honors at the view layer.
//   hold     → row leaves its worklist until `until`; resurfaces ON the date.
//              A reply from them voids the hold (truth.py compares inbound
//              time > entry ts — so ts MUST be a full UTC ISO timestamp).
//   personal → operator-owned deal: automation stops proposing touches; their
//              replies still surface in the "In your hands" strip.
//   unhold / release → remove the entry (reversible from the UI, tenet 15).
// Buckets in board.json never change — directives re-section the view only.
// Mirror of gating/route.ts: registry write + markBoardDirty; the board route
// re-runs truth.py on the next (client-forced) GET — gating does not re-run it.
const REG = path.join(VAULT, "pipeline/operator-directives.json");
const KEY_RX = /^[\w.@+-]{1,120}$/; // company key or freemail mailbox

interface Entry { domain?: string; email?: string; until?: string; reason?: string; by?: string; ts?: string }
interface Registry { _meta?: Record<string, unknown>; holds?: Entry[]; personal?: Entry[] }

interface Body {
  key?: string;
  action?: "hold" | "unhold" | "personal" | "release";
  until?: string;
  reason?: string;
}

function readReg(): Registry {
  try { return JSON.parse(fs.readFileSync(REG, "utf8")) as Registry; }
  catch { return { holds: [], personal: [] }; }
}

function writeReg(reg: Registry) {
  if (reg._meta) reg._meta.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(REG, JSON.stringify(reg, null, 1));
}

const sameCompany = (e: Entry, key: string) => companyKey(e.email || e.domain || "") === companyKey(key);

// write domain: key, or email: key when the key is a mailbox (freemail leads)
function newEntry(key: string, reason: string, until?: string): Entry {
  const e: Entry = key.includes("@") ? { email: key } : { domain: key };
  if (until) e.until = until;
  e.reason = reason;
  e.by = "operator";
  e.ts = new Date().toISOString(); // full UTC ISO — void-on-inbound compares li_d > ts
  return e;
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Body;
  const key = (b.key ?? "").trim().toLowerCase();
  if (!key || !KEY_RX.test(key)) return Response.json({ error: "a valid company key is required" }, { status: 400 });
  const reason = (b.reason ?? "").trim();
  const reg = readReg();
  reg.holds = reg.holds ?? [];
  reg.personal = reg.personal ?? [];

  if (b.action === "hold") {
    const until = (b.until ?? "").trim();
    const today = new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until + "T12:00:00Z"))) {
      return Response.json({ error: "until must be a date like 2026-07-14" }, { status: 400 });
    }
    if (until <= today) return Response.json({ error: "the hold date must be after today — the company comes back ON that date" }, { status: 400 });
    const prev = reg.holds.find((e) => sameCompany(e, key));
    if (prev && prev.until === until) {
      return Response.json({ ok: true, action: "hold", already: true, until }); // idempotent: already held to that date
    }
    reg.holds = reg.holds.filter((e) => !sameCompany(e, key)); // upsert: a new date replaces the old hold
    reg.holds.push(newEntry(key, reason, until));
    writeReg(reg);
    markBoardDirty("hold");
    return Response.json({ ok: true, action: "hold", until, replaced: !!prev });
  }

  if (b.action === "unhold") {
    const before = reg.holds.length;
    reg.holds = reg.holds.filter((e) => !sameCompany(e, key));
    const removed = before - reg.holds.length;
    if (removed > 0) { writeReg(reg); markBoardDirty("unhold"); }
    return Response.json({ ok: true, action: "unhold", removed, already: removed === 0 });
  }

  if (b.action === "personal") {
    const dup = reg.personal.some((e) => sameCompany(e, key));
    if (dup) return Response.json({ ok: true, action: "personal", already: true }); // idempotent
    reg.personal.push(newEntry(key, reason));
    writeReg(reg);
    markBoardDirty("personal");
    return Response.json({ ok: true, action: "personal" });
  }

  if (b.action === "release") {
    const before = reg.personal.length;
    reg.personal = reg.personal.filter((e) => !sameCompany(e, key));
    const removed = before - reg.personal.length;
    if (removed > 0) { writeReg(reg); markBoardDirty("release"); }
    return Response.json({ ok: true, action: "release", removed, already: removed === 0 });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
