---
description: The single VELAB drafting command. Classifies each work item (LLM layer), then drafts it — only cold is templated. Read-only; chains into /stage-drafts.
argument-hint: "[--leads <file.json>]   (default: inbox-driven)"
---

<!-- Reconstructed 2026-06-20 from harness memory (project_velab_draft_command,
     project_velab_cold_followup_command) after the ~/.claude wipe. Supersedes the
     old per-type commands. Voice assets in vault/reference/draft-examples verified. -->

You are running **/draft** — ONE drafting command with an LLM classification layer.
READ-ONLY: you classify and draft; you NEVER send and NEVER stage (that is
`/stage-drafts`, a separate operator-gated step).

## Inputs — the SAME certified truth as /inbox-check (engine v2, 2026-07-02)
- **Default (inbox-driven):** derive + read the persisted board:
  ```
  python3 $VELAB/core/truth.py && python3 $VELAB/core/certify.py
  ```
  then read `$VAULT/state/board.json`. Work items come from its buckets:
  `owe` + `owe-review` (replies to draft), `followup_due` awaiting rows (nudges),
  and `cold_substate == "due"` (the cold worklist — this IS the real due list;
  never re-derive your own). The old second engine (`inbox_view.py`) is RETIRED
  for CLASSIFICATION only — do not call it to bucket work items. (It remains the live
  cadence-math authority imported by cadence_gate/send_batch/inbox_audit — doc corrected
  2026-07-08 after the audit flagged the blanket "retired" wording as drift.)
- **`--leads <file.json>`:** fresh verified leads = new cold opens. ($ARGUMENTS)
- You may combine both.

## Step 0 — freshness (the engine already did it)
A "fresh" lead is fresh only if it has NO company row in board.json (the board covers
all mail since 2026-05-01 plus the corpus backfill). If a lead file entry's
`identity.company_key` already exists on the board with touches > 0, it is NOT a cold
open — treat it as a follow-up at its true cadence position (`touches` on the row).

## Step 1 — classify (emit the summary FIRST)
Map each item via `$VAULT/reference/reply-triage.md` + the cadence
rules to ONE draft decision, then print a classification summary before drafting:
- fresh / new lead → **COLD-01-INITIAL**
- cadence-due, no reply → **COLD-02 / COLD-03** (by position)
- reply → contextual by intent: PRICING→WARM reply, MEETING→propose/confirm,
  DISTRIBUTOR→ack-escalate, etc. (reply in the client's language)
- `formal_bid` → **Licitador hand-off** (NOT an email)
- reroute → COLD-01 to the new named contact
- opt-out → acknowledge + add to DNC
- auto-reply → skip
- engaged-domain (a sibling at a domain that already replied) → do NOT cold-draft;
  the cadence gate will block it anyway.

## Step 2 — draft
- **Only cold is templated.** Consult `$VAULT/reference/draft-examples/`
  FIRST as the approved voice (keyed `<client-type>__<lang>__<stage>.md`); fall back
  to the sent corpus. Do NOT freelance cold copy.
- **Banned cold phrasing:** "genuinely", "American-made", finality/breakup language
  (except COLD-03 which doubles as the break-up), and referral-asks ("point me to the
  right person"). The only allowed redirect is "If we've reached the wrong person…".
- **Clean names + correct greetings:** never raw domain names in greeting/subject;
  ES/EN gender-correct (Estimada/Estimado; neutral team greeting if unknown).
- **Country-doubling rule:** if a company name contains its country, use the SHORT
  name in greeting + body, full name in subject only.
- Replies are contextual (not templated), grounded in the thread.
- **Warm nudges (ES) have a GOLD-STANDARD format** (operator-canonized 2026-07-06):
  3 micro-paragraphs — gender-correct first-name greeting, ONE adapted courtesy line,
  ONE light ask/invitation, "Un cordial saludo,". See WARM-NUDGE in
  `vault/reference/warm-templates.md` + verbatim examples in
  `draft-examples/lab-distributor-latam__es__warm-nudge.md`. Do not deviate.

## Step 3 — output
Print the classification summary + the inline drafts. Optionally write pack(s).

**PACK RULE (V4.1, 2026-07-04): one company per WARM pack.** The pack is the
staging unit — bundling warm replies stages other companies' mail as a side
effect (the Staged 0→5 audit bug). Cold batches stay bundled.
```
warm (REPLY/FOLLOWUP…):  vault/pipeline/drafts/<date>__reply__<domain-slug>.json   (exactly ONE entry)
cold batches:            vault/pipeline/drafts/<date>__cold-<type>__<segment>__<geo>.json
```
which chains into **/stage-drafts**. Save operator-approved drafts back into
`draft-examples/` so the voice library GROWS. Never send, never stage.
