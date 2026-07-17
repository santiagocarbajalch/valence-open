import fs from "node:fs";
import path from "node:path";
import { VAULT, TOOLS, PY, safeUnder, run } from "@/lib/vault";
import { startJob } from "@/lib/jobs";
import { checkApproval } from "@/lib/sendGuard";
import { markBoardDirty, humanPackName } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// THE GUARDED SEND. This is the single most hazardous route in the cockpit.
// COCKPIT_SEND_ENABLED gates it: the systemd unit sets it to "1" (operator-
// authorized 2026-06-30), so sends through this route are REAL — the cockpit
// shows a persistent SEND: LIVE pill. Unset the flag to go dark again (the
// pipeline can then be exercised end-to-end with nothing leaving).
//
// Even while live, every layer still applies:
//   1. server-side guardrail (checkApproval) — verbatim operator text, mirrors the
//      hook: deny on qualifier / missing send verb / empty. Never synthesized.
//   2. confirm count must equal the pack's recipient count (grant_send also enforces).
//   3. console approval is recorded through send_batch's INTENDED channel — a
//      console-approvals sidecar (load_console_approval) + a 'drafted' queue anchor
//      row so the drafted->approved->sent reconciliation can track the send. Without
//      these two, approval_report blocks every recipient as missing_queue_entry.
//   4. grant_send.py mints a recipient-scoped, time-boxed, single-use ticket.
//   5. send_batch.py runs DETACHED (65s/email) and writes a sent-completion file.
//   6. smtp.js's 50/day ledger + reputation pause remain the hard backstop.
const DRAFTS_DIR = path.join(VAULT, "pipeline/drafts");
const QUEUE = path.join(VAULT, "pipeline/queue.md");
const CONSOLE_APPROVALS = path.join(VAULT, "pipeline/console-approvals");
const GRANT = path.join(TOOLS, "grant_send.py");
const SEND_BATCH = path.join(TOOLS, "send_batch.py");
const MEETINGS = path.join(VAULT, "pipeline/meetings.json");
const SEND_ENABLED = process.env.COCKPIT_SEND_ENABLED === "1";

interface Body {
  file?: string;
  approval?: string; // operator's verbatim, typed approval
  confirm?: number; // must equal recipient count
  batchSource?: string;
  queueDate?: string; // YYYY-MM-DD
  draftMd?: string; // path to the markdown the pack came from (send_batch requires it)
}

interface Entry {
  email: string;
  institution: string;
  toName: string;
}

// Pull every draft entry (email + the two fields the queue reconciliation matches on).
function entriesOf(abs: string): Entry[] {
  try {
    const p = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
    const out: Entry[] = [];
    for (const v of Object.values(p)) {
      if (Array.isArray(v))
        for (const e of v) {
          const r = e as { to_email?: string; institution?: string; to_name?: string };
          if (r?.to_email) out.push({ email: r.to_email, institution: r.institution ?? "", toName: r.to_name ?? "" });
        }
    }
    return out;
  } catch {
    return [];
  }
}

// Match python Path.stem: strip only the final ".json" (so "x.threaded.json" -> "x.threaded"),
// which is exactly how send_batch's load_console_approval keys the sidecar.
function stemOf(file: string): string {
  return file.replace(/\.json$/, "");
}

// send_batch reconciles console-approved sends by flipping a 'drafted' queue row to
// 'approved' then 'sent' — matched EXACTLY on (queue_date, institution, to_name). If
// /draft never registered the pack (or used a different batch source), no such row
// exists and the whole batch aborts. Append an honest 'drafted' anchor when missing.
// Append-only + idempotent: existing rows are never rewritten.
function ensureQueueRows(entries: Entry[], batchSource: string, queueDate: string, relPath: string): number {
  let text = "";
  try {
    text = fs.readFileSync(QUEUE, "utf8");
  } catch {
    text = "";
  }
  const rowExists = (e: Entry) => {
    for (const line of text.split("\n")) {
      if (!line.startsWith("|") || line.includes("---")) continue;
      const parts = line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((s) => s.trim());
      if (parts.length !== 6 || parts[0] === "Date") continue;
      const [d, src, lead, inst] = parts;
      if (d === queueDate && src === batchSource && inst === e.institution && lead === e.toName) return true;
    }
    return false;
  };
  const rows: string[] = [];
  for (const e of entries) {
    if (!e.institution || !e.toName) continue; // reconciliation needs both; skip malformed
    if (rowExists(e)) continue;
    rows.push(`| ${queueDate} | ${batchSource} | ${e.toName} | ${e.institution} | drafted | ${relPath} |`);
  }
  if (rows.length) {
    const needsNL = text.length > 0 && !text.endsWith("\n");
    fs.appendFileSync(QUEUE, (needsNL ? "\n" : "") + rows.join("\n") + "\n");
  }
  return rows.length;
}

// The intended console approval channel send_batch reads (matched by pack == stem).
// Records the operator's verbatim words for the audit trail. APPENDS one JSON
// line per approval to a running log — never a per-pack file (2026-07-12 fold):
// send_batch's load_console_approval already dual-reads log.jsonl + any legacy
// per-pack sidecars, so nothing on the reading side needed to move first.
function writeConsoleApproval(stem: string, emails: string[], approvalText: string) {
  fs.mkdirSync(CONSOLE_APPROVALS, { recursive: true });
  const rec = {
    pack: stem,
    approved: emails,
    disapproved: [],
    approved_by: "operator (cockpit)",
    approval_text: approvalText,
    ts: new Date().toISOString(),
  };
  fs.appendFileSync(path.join(CONSOLE_APPROVALS, "log.jsonl"), JSON.stringify(rec) + "\n");
}

// Doctrine v1.1: "the invite rides the send gate". A HELD calendar event whose
// client attendee is a recipient of the approved pack fires its invite now
// (create_meeting.py confirm → sendUpdates=all → registry status "invited",
// which is what makes it board truth). Held events NOT covered by this send
// stay silent holds, exactly as before.
async function confirmHeldMeetings(recipients: string[]): Promise<{ eventId: string; ok: boolean; error?: string }[]> {
  let reg: { meetings?: { event_id?: string; status?: string; attendees?: string[] }[] };
  try { reg = JSON.parse(fs.readFileSync(MEETINGS, "utf8")); } catch { return []; }
  const recips = new Set(recipients.map((r) => r.toLowerCase()));
  const due = (reg.meetings ?? []).filter(
    (m) => m.event_id
      && (m.status ?? "").toLowerCase().startsWith("held")
      && (m.attendees ?? []).some((a) => recips.has((a ?? "").toLowerCase())),
  );
  const out: { eventId: string; ok: boolean; error?: string }[] = [];
  for (const m of due) {
    const r = await run(PY, ["create_meeting.py", "--json", "confirm", "--event-id", m.event_id!], { cwd: TOOLS, timeout: 40_000 });
    let ok = false, error: string | undefined;
    try { ok = !!(JSON.parse(r.stdout) as { ok?: boolean }).ok; } catch { error = r.stderr.slice(-200) || "confirm failed"; }
    if (!ok && !error) error = r.stderr.slice(-200) || "confirm failed";
    out.push({ eventId: m.event_id!, ok, ...(error ? { error } : {}) });
  }
  if (out.some((x) => x.ok)) markBoardDirty("meeting:confirm");
  return out;
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Body;

  // 1 — guardrail FIRST, always (even when dark) so the UI can show the verdict.
  const guard = checkApproval(b.approval);
  if (!guard.ok) {
    return Response.json({ ok: false, blocked: guard.code, reason: guard.reason }, { status: 403 });
  }

  const baseAbs = safeUnder(DRAFTS_DIR, b.file ?? "");
  if (!baseAbs || !fs.existsSync(baseAbs)) return Response.json({ ok: false, error: "bad pack" }, { status: 400 });

  // SEND WHAT WAS STAGED: if the gate chain produced a .threaded.json twin, that is
  // the artifact that passed thread_gate/verify and sits in Gmail Drafts — sending
  // the raw base pack would re-classify follow-ups as un-threaded and drop them.
  let abs = baseAbs;
  let file = b.file ?? "";
  if (!file.endsWith(".threaded.json")) {
    const twin = baseAbs.replace(/\.json$/, ".threaded.json");
    if (fs.existsSync(twin)) {
      abs = twin;
      file = file.replace(/\.json$/, ".threaded.json");
    }
  }

  // 2 — confirm count must match recipients
  const entries = entriesOf(abs);
  const recips = entries.map((e) => e.email);
  if (typeof b.confirm !== "number" || b.confirm !== recips.length) {
    return Response.json(
      { ok: false, blocked: "CONFIRM_MISMATCH", reason: `confirm (${b.confirm}) must equal recipient count (${recips.length})` },
      { status: 400 },
    );
  }

  // Dark mode (flag unset) — pipeline exercised, but nothing leaves the box.
  if (!SEND_ENABLED) {
    return Response.json({
      ok: false,
      dark: true,
      reason: "Send is disabled (COCKPIT_SEND_ENABLED!=1). Guardrail + confirm PASSED; flip the flag after review to go live.",
      recipients: recips.length,
      approval: guard.approval,
    });
  }

  // 3 — mint the grant ticket with the operator's verbatim words.
  const grant = await run(
    PY,
    [GRANT, "--pack", abs, "--confirm", String(b.confirm), "--operator-approval", guard.approval, "--minutes", "60"],
    { cwd: TOOLS, timeout: 30_000 },
  );
  if (grant.code !== 0) {
    return Response.json({ ok: false, error: "grant failed", stderr: grant.stderr.slice(-500) }, { status: 502 });
  }

  // 4 — wire send_batch's console-approval channel: sidecar (approval of record) +
  // a 'drafted' queue anchor so the drafted->approved->sent reconciliation tracks it.
  const stem = stemOf(file);
  const batchSource = b.batchSource ?? stem;
  const queueDate = b.queueDate ?? new Date().toISOString().slice(0, 10);
  const relPath = b.draftMd ?? `vault/pipeline/drafts/${file}`;
  writeConsoleApproval(stem, recips, guard.approval);
  const rowsAdded = ensureQueueRows(entries, batchSource, queueDate, relPath);

  // 5 — run the batch sender DETACHED (65s/email); poll via /api/job.
  const args = [
    SEND_BATCH,
    "--drafts-json", abs,
    "--draft-md", relPath, // required label; send_batch carries it, does not read it
    "--batch-source", batchSource,
    "--queue-date", queueDate,
  ];
  const jobId = startJob({
    label: "send",
    argv: [PY, ...args],
    cwd: "/opt/velab/workspace",
    context: {
      kind: "send",
      title: `Sending ${recips.length} email${recips.length === 1 ? "" : "s"} — ${humanPackName(file)}`,
      packFile: file,
      total: recips.length,
      view: "cockpit",
    },
  });

  // 5b — truth follows the send IMMEDIATELY (operator 2026-07-12: "state must
  // update right away"). The board's who-owes-whom comes from the Gmail corpus,
  // which otherwise refreshes on a 5-min timer — so a sent lead sat in "They're
  // waiting on you" for minutes after the batch finished. This detached watcher
  // waits for the send job's done-file, pulls today's corpus (Enviados included,
  // so the send truth stays Gmail, per doctrine), and marks the board dirty; the
  // next board load then re-runs the engine. Bounded: gives up after 2h.
  const doneFile = `/opt/velab/workspace/runs/console-jobs/${jobId}.done`;
  const watch =
    'n=0; while [ ! -f "$1" ] && [ $n -lt 1440 ]; do sleep 5; n=$((n+1)); done; ' +
    "cd /opt/velab/workspace/tools && python3 corpus_pull.py --mode today; " +
    'printf \'{"ts":"%s","reason":"send:complete"}\\n\' "$(date -u +%FT%TZ)" > /opt/velab/vault/state/board.dirty';
  startJob({
    label: "send-refresh",
    argv: ["bash", "-c", watch, "velab-send-refresh", doneFile],
    cwd: "/opt/velab/workspace",
    context: { kind: "refresh", title: "Updating the board from Gmail after the send", view: "cockpit" },
  });

  // 6 — fire held calendar invites covered by this approved send (doctrine v1.1).
  const meetingConfirms = await confirmHeldMeetings(recips);

  return Response.json({ ok: true, jobId, recipients: recips.length, granted: true, batchSource, queueRowsAdded: rowsAdded, meetingConfirms });
}
