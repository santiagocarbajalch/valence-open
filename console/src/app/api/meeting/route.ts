import fs from "node:fs";
import path from "node:path";
import { run, TOOLS, PY, VAULT, safeUnder } from "@/lib/vault";
import { markBoardDirty } from "@/lib/pipeline";
import { checkApproval } from "@/lib/sendGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/meeting — create_meeting.py wrapper (OAuth-as-Robert).
//   action=create  → hold an event + mint Meet link (sendUpdates=none).
//   action=confirm → fire the invite at send-GO (sendUpdates=all).
//   action=cancel  → delete a held event.
// `create` honors the standing rule by NOT notifying guests yet; the invite rides
// the send gate via `confirm`. The Google call is ~1-2s so it runs inline.
interface Body {
  action?: "create" | "confirm" | "cancel";
  summary?: string;
  start?: string; // ISO local datetime
  durationMin?: number;
  tz?: string;
  attendees?: string[];
  description?: string;
  eventId?: string;
  dryRun?: boolean;
  approval?: string; // confirm only: operator's verbatim send approval (mirrors /api/send)
  // create only: bind the held event to this company's open draft — the Meet
  // link is inserted into the body (before the sign-off) and _meet_event_id is
  // set on the entry, deterministically (apply_pack_extras.py). The pack must
  // then be re-staged; the invite still fires only at approved send.
  draftFile?: string; // base pack file name
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Body;
  const args: string[] = ["create_meeting.py", "--json"];
  if (b.dryRun) args.push("--dry-run");

  if (b.action === "confirm") {
    if (!b.eventId) return Response.json({ error: "eventId required" }, { status: 400 });
    // confirm fires the invite (sendUpdates=all) as Robert — it is outbound and
    // must ride the send gate. Require the operator's verbatim approval, exactly
    // as /api/send does; the normal path (invites riding an approved email send)
    // runs through /api/send's confirmHeldMeetings and is unaffected.
    if (!b.dryRun) {
      const guard = checkApproval(b.approval);
      if (!guard.ok) {
        return Response.json({ ok: false, blocked: guard.code, reason: guard.reason }, { status: 403 });
      }
    }
    args.push("confirm", "--event-id", b.eventId);
  } else if (b.action === "cancel") {
    if (!b.eventId) return Response.json({ error: "eventId required" }, { status: 400 });
    args.push("cancel", "--event-id", b.eventId);
  } else {
    // default: create
    if (!b.summary || !b.start) return Response.json({ error: "summary + start required" }, { status: 400 });
    args.push("create", "--summary", b.summary, "--start", b.start, "--tz", b.tz ?? "America/Chicago", "--duration-min", String(b.durationMin ?? 30));
    if (b.attendees?.length) args.push("--attendees", b.attendees.join(","));
    if (b.description) args.push("--description", b.description);
  }

  const r = await run(PY, args, { cwd: TOOLS, timeout: 40_000 });
  try {
    const out = JSON.parse(r.stdout) as { ok?: boolean; event_id?: string; meet_url?: string; when?: string };
    // a real create/confirm/cancel changes engine-visible state (meetings registry)
    if (out.ok && !b.dryRun) markBoardDirty(`meeting:${b.action ?? "create"}`);

    // create + draft binding: put the Meet link in the open draft and stamp the
    // event id on the entry — one deterministic step, same mutator the draft
    // workbench uses. Failure here never un-creates the hold; it is reported so
    // the operator can paste the link by hand.
    if ((b.action ?? "create") === "create" && out.ok && !b.dryRun && b.draftFile && out.event_id && out.meet_url) {
      const packAbs = safeUnder(path.join(VAULT, "pipeline/drafts"), b.draftFile.replace(/\.threaded\.json$/, ".json"));
      if (!packAbs || !fs.existsSync(packAbs)) {
        return Response.json({ ...out, draftUpdated: false, draftError: "that draft isn't on file anymore — paste the Meet link into the reply yourself" });
      }
      const when = b.start
        ? new Date(b.start).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) + ` (${b.tz ?? "America/Chicago"})`
        : "";
      const ap = await run(PY, [
        "apply_pack_extras.py", "--pack", packAbs,
        "--meet-event-id", out.event_id, "--meet-url", out.meet_url, "--meet-when", when,
      ], { cwd: TOOLS, timeout: 20_000 });
      let applied = false;
      try { applied = !!(JSON.parse(ap.stdout) as { ok?: boolean }).ok; } catch { /* fall through */ }
      return Response.json({
        ...out, draftUpdated: applied,
        ...(applied ? {} : { draftError: "couldn't write the link into the draft — paste it into the reply yourself" }),
      });
    }
    return Response.json(out);
  } catch {
    return Response.json({ ok: false, error: r.stderr.slice(-400) || "meeting tool failed" }, { status: 502 });
  }
}
