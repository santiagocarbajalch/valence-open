import { run, PY } from "@/lib/vault";
import { fixture } from "@/lib/fixtures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Full conversation for one company — the cockpit's right pane.
// core/thread_dump.py reads the SAME corpus shards truth.py derives from, keyed
// by the SAME identity.company_key, so the thread always matches the board row.
// Fork-proof: grouped by company + date, not Gmail THRID (thread-fork audit).

const CORE = "/opt/velab/core";
const KEY_RX = /^[\w.@+-]{1,120}$/; // company key or freemail mailbox — no shell surprises

export async function GET(req: Request) {
  const fx = fixture("thread");
  if (fx) return Response.json(fx);
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!KEY_RX.test(key)) return Response.json({ error: "bad key" }, { status: 400 });
  const r = await run(PY, ["thread_dump.py", "--key", key], { cwd: CORE, timeout: 30_000 });
  try {
    return Response.json(JSON.parse(r.stdout));
  } catch {
    return Response.json({ error: "thread unavailable", detail: r.stderr.slice(-300) }, { status: 502 });
  }
}
