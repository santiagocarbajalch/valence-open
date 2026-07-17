---
description: Thread → gate → verify → stage a drafts pack into Gmail Drafts (house format), gated on review cards. Never sends.
argument-hint: "<pack>.json [<pack2>.json ...]   [--sent-file <batch>.json for follow-ups]"
---

<!-- Reconstructed 2026-06-20 from harness memory (project_velab_stage_drafts_skill)
     + the surviving skill at workspace/skills/velab-stage-drafts/. All scripts verified. -->

You are running **/stage-drafts** — the step between drafting and sending. It turns a
drafts pack into properly-threaded, house-formatted, content-checked drafts sitting in
the Gmail Drafts box. **It NEVER sends.** Sending is a separate, per-batch
operator-granted step (`grant_send.py`; smtp.js is default-DENY). Since 2026-06-08 the
agent MAY create the grant itself ONLY with the operator's verbatim approving words in
`--operator-approval` — the hook blocks bare grants, not properly-quoted ones (doc
corrected 2026-07-08). A content gate (content_gate.py: empty envelope / 72h duplicate /
banned language incl. ISO 13485) also runs at dispatch on every send path.

Packs to process: **$ARGUMENTS**. Run the pipeline IN ORDER. Stop the moment a gate
fails — do not proceed to the next step.

```
# Step 0 — CADENCE GATE (timing off at stage; exit 3 = STOP, do not thread/verify/stage)
python3 $VELAB/workspace/tools/cadence_gate.py --pack <pack>.json --no-timing

# Step 1 — recover threading from the Gmail SENT box (never All-Mail), write enriched copy
node $VELAB/workspace/skills/velab-stage-drafts/scripts/recover_threads.js --pack <pack>.json --json
#   -> <pack>.threaded.json with in_reply_to + references; tags _thread: threaded|new_cold

# Step 1.5 — STATIC THREADING GATE (exit 3 = STOP)
python3 $VELAB/workspace/tools/thread_gate.py --pack <pack>.threaded.json

# Step 2 — REVIEW CARDS (exit 2 = HARD fail = STOP). Show the card table to the operator.
python3 $VELAB/workspace/skills/velab-stage-drafts/scripts/verify_drafts.py --pack <pack>.threaded.json
#   -> pass EVERY pack in one call so `dedupe` sees the whole set.
#   -> for FOLLOW-UPS add: --sent-file <this-batch>.json  (else dedupe false-flags every follow-up)

# Step 3 — ONLY if 1.5 + 2 are CLEAR and the operator approves: stage to Gmail Drafts
node $VELAB/workspace/tools/stage_drafts_in_gmail.js --pack <pack>.threaded.json
#   -> idempotent APPEND to [Gmail]/Borradores; house HTML + cc to the sales read-copy mailbox + petri attach.
#      REFUSES un-threaded follow-ups at the tool layer.

# Step 3.5 — LIVE THREADING GATE (header-present != threaded; exit 3 = do NOT send later)
python3 $VELAB/workspace/skills/velab-stage-drafts/scripts/verify_draft_threading.py
#   -> proves each staged draft shares its original's X-GM-THRID (catches a valid-looking
#      anchor pointing at the WRONG message — the 9/50 split the static checks can't see).
```

## Hard rules
- 🔒 **Staging is not sending.** Stop at the Drafts box. Never authorize a send — a
  hook blocks agent self-grant; sends need a per-batch operator grant.
- **Never stage a pack that fails a HARD card** (thread-integrity, cadence-placement,
  company-crosswiring, replied-suppression, dnc, dedupe). Fix the pack, re-run, then stage.
- **Anchor = Sent box, never All-Mail** (All-Mail contains drafts → anchoring to a
  draft splits the thread). recover_threads already enforces this.
- For a bulk threaded SEND later: always canary-send 1–2 and run the post-send
  X-GM-THRID check (`verify_threading_landed.js`) before releasing the batch.
- Read-only against IMAP except the Step-3 Drafts APPEND.

Cards are meant to GROW — a new failure mode = one new card, not a worked-around bug.
