// Server-side mirror of workspace/tools/send_gate_hook.py.
//
// WHY THIS EXISTS: send_gate_hook.py is a Claude Code PreToolUse hook — it only
// guards actions taken by an agent *inside* a Claude Code session. A Next.js API
// route runs as a server process OUTSIDE that hook, so the hook does NOT protect a
// cockpit "send" button. This module re-implements the hook's verbatim-approval
// checks so the cockpit cannot grant a send on anything but a clean, standalone,
// operator-typed approval. The 2026-06-29 "print inline ≠ send" failure is the
// reason the qualifier check is here. smtp.js's default-deny ledger remains the
// hard backstop regardless.
//
// The operator's approval text MUST be typed by a human in the UI and passed
// through verbatim — the server NEVER synthesizes it.

// A clean approval must CONTAIN an unambiguous send verb...
const SEND_TOKEN =
  /\b(send|sent|send it|send them|send both|send out|sent out|ship( it)?|fire( it| away)?|go ahead|approve[d]?|blast|deliver (it|them))\b/i;

// ...and must NOT carry a qualifier meaning "not now / print only / do X first".
const QUALIFIER =
  /\b(but first|before (you|we)|don'?t send|do not send|no send|hold( on| off)?|wait|not yet|hang on|print|render( the| these| those| it| them)|inline|in line|show me (the|these|those|it|them|first|again)|draft(s)? (only|first)|just draft|only draft|stage (it|them|only)|then (we|i) can|once you('?re| are)?( done)?|after you|let me (see|review|look)|review first)\b/i;

export type GuardResult =
  | { ok: true; approval: string }
  | { ok: false; code: "EMPTY" | "QUALIFIED" | "NO_SEND_VERB"; reason: string };

export function checkApproval(raw: string | undefined | null): GuardResult {
  const approval = (raw ?? "").trim();
  if (!approval) {
    return {
      ok: false,
      code: "EMPTY",
      reason:
        "No operator approval text. A send requires the operator's verbatim, standalone approval (e.g. \"send batch 1\"). Type it to proceed.",
    };
  }
  if (QUALIFIER.test(approval)) {
    return {
      ok: false,
      code: "QUALIFIED",
      reason:
        "Qualified/ambiguous approval. The text contains a qualifier ('but first', 'hold', 'wait', 'print', 'inline', 'draft only', 'then we can', 'once you…'). A request to print/show/stage or to do something FIRST is never send approval. Provide a clean standalone 'send it / go ahead'.",
    };
  }
  if (!SEND_TOKEN.test(approval)) {
    return {
      ok: false,
      code: "NO_SEND_VERB",
      reason:
        "No unambiguous send verb (send / send it / go ahead / ship it). 'draft', 'stage', 'print', 'show' are NOT send.",
    };
  }
  return { ok: true, approval };
}
