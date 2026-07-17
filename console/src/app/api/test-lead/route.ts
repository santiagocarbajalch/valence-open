import fs from "node:fs";
import path from "node:path";
import { VAULT } from "@/lib/vault";
import { DRAFTS_DIR, markBoardDirty, companyKey } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The TEST-lead sandbox (V4.1 Phase 7). Seeds ONE draft to an address the
// operator owns so the whole pipeline — edit, revise, stage, send gate, real
// dispatch — can be proven end-to-end without touching a customer.
//   • the address is registered in vault/pipeline/test-identities.json, which
//     core/identity.py folds into TEST_KEYS → the engine suppresses it from
//     every count, worklist, cadence and close-out (class "test");
//   • the draft pack is a normal per-company pack (batch_label "TEST — …"), so
//     staging and the send gate treat it EXACTLY like real mail — no weakening;
//   • purge removes the packs, twins, markers and the registry entry.

const REGISTRY = path.join(VAULT, "pipeline/test-identities.json");
// Deployment sets the operator's own test address via env; default is a placeholder.
const DEFAULT_EMAIL = process.env.VELAB_TEST_EMAIL || "ops@example.com";
const PACK_PREFIX = "__reply__test-";

function readRegistry(): { emails: string[] } {
  try { return JSON.parse(fs.readFileSync(REGISTRY, "utf8")); } catch { return { emails: [] }; }
}
function testPacks(): string[] {
  try {
    return fs.readdirSync(DRAFTS_DIR).filter((n) => n.includes(PACK_PREFIX));
  } catch { return []; }
}

export async function GET() {
  const reg = readRegistry();
  return Response.json({ email: reg.emails[0] ?? DEFAULT_EMAIL, seeded: testPacks().some((n) => !n.endsWith(".threaded.json") && !n.endsWith(".staged.json")), packs: testPacks() });
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { action?: "seed" | "purge"; email?: string };

  if (b.action === "seed") {
    const email = (b.email ?? DEFAULT_EMAIL).toLowerCase().trim();
    if (!email.includes("@")) return Response.json({ error: "need a full email address" }, { status: 400 });
    // the test lead must be a personal address (freemail → companyKey keeps the
    // full mailbox). A company domain would collide with a real lead's identity.
    if (!companyKey(email).includes("@")) {
      return Response.json({ error: `${email} looks like a company address — the test lead must be a personal address you own (e.g. a Gmail).` }, { status: 400 });
    }
    const reg = readRegistry();
    if (!reg.emails.includes(email)) {
      reg.emails = [email, ...reg.emails];
      fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
      fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 1));
    }
    const today = new Date().toISOString().slice(0, 10);
    const slug = email.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
    const packName = `${today}${PACK_PREFIX}${slug}.json`;
    const abs = path.join(DRAFTS_DIR, packName);
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, JSON.stringify({
        date: today,
        batch_label: `TEST — pipeline check (${email})`,
        status: "draft",
        drafts: [{
          institution: "TEST — you",
          to_email: email,
          to_name: "Operator (TEST)",
          subject: "TEST — Valence pipeline check",
          body: "This is a TEST message from your own pipeline.\n\nIf you are reading it in your inbox, the full path worked: draft, stage to Gmail Drafts, send gate, real dispatch.\n\nSafe to delete.",
          draft_type: "REPLY",
          in_reply_to: null,
          _thread: "pending",
        }],
      }, null, 2));
    }
    markBoardDirty("test-lead-seed");
    return Response.json({ ok: true, email, pack: packName });
  }

  if (b.action === "purge") {
    let removed = 0;
    for (const n of testPacks()) {
      try { fs.unlinkSync(path.join(DRAFTS_DIR, n)); removed++; } catch { /* gone */ }
    }
    try { fs.writeFileSync(REGISTRY, JSON.stringify({ emails: [] }, null, 1)); } catch { /* keep */ }
    markBoardDirty("test-lead-purge");
    return Response.json({ ok: true, removed });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
