---
description: Company-truth inbox board — persisted board.json from truth engine v2, adversarially certified, DETERMINISTICALLY rendered. Read-only.
argument-hint: "[full] [--frozen] [--full-cert]"
---

# /inbox-check — company-truth inbox board (READ-ONLY, engine v2 + canonical view)

Rebuilt 2026-07-03 after the format-drift audit; PARITY REBUILD same day. ONE
persisted artifact — `vault/state/board.json` — is the truth; ONE canonical view —
`core/render_board.py build_view()` — is the format. This command prints its
markdown serialization; the valence-console cockpit consumes `render_board.py
--json` and renders the SAME sections, row cells, action strings and cert lines.
If the cockpit ever shows a different string than this board, that is a bug by
definition. You never re-tabulate the board freehand: freehand rendering is what
caused format drift, duplicate rows, and stale-verdict actions (the audit).

## Approval model
- **Read / analyze / classify / derive = innate approval.** That is the job.
- **Sending / drafting / staging / calendar writes = NOT part of this command.** A later
  send requires an explicit, standalone "send"/"go" — edits, answers, and confirmations
  are never approval.

## Steps (every run, ~4s)
```
python3 $VELAB/core/truth.py
python3 $VELAB/core/certify.py            # --full if the quick cert looks suspicious
python3 $VELAB/core/auditor.py            # cross-plane data-integrity guard — fails loud
python3 $VELAB/core/render_board.py --digest
```
The **Auditor** (`auditor.py`) re-derives truth from the corpus and cross-checks
it against the persisted + rendered board. Its verdict prints at the TOP of the
digest. A `❌ AUDITOR` banner (critical) means a company the operator needs to
see may be invisible, a registry silently dropped, or the board stale — do not
trust the board until it clears. Warnings are advisory. It exits non-zero on a
critical so a timer/cron marks the failure (unlike integrity.py, which failed
silently for 10h on 2026-07-14).
Print the DIGEST **verbatim** — it IS the board (operator format call 2026-07-13:
the full ledger was illegible as the default; the digest is now what /inbox-check
prints). Then you may add a SHORT judgment paragraph below it (operator context on
ambiguous rows, cross-thread observations), but you must NEVER re-tabulate,
re-bucket, reorder, or restyle the rendered sections, and NEVER invent an Action
a row doesn't carry — both rules apply to the digest exactly as they did to the
ledger.

**NO-CHERRY-PICK RULE (operator complaint 2026-07-16).** Any judgment you add
must MAP THE WHOLE FIELD, never one bucket. If you name what needs a reply you
must ALSO name — by count — the follow-ups due, the in-flight leads, and the
cold-follow-up count, and say which section each lives in. Selectively narrating
NEED REPLY while leaving FOLLOW-UP DUE / IN FLIGHT / COLD silent (the 2026-07-16
defect) is a violation. If you have nothing to add beyond the digest, add nothing
— but do not surface a partial view of the field as if it were the whole board.

If ❌ NOT CERTIFIED: show the failure, do NOT assert states for the affected
companies, fix the source first. A wrong board is worse than a late one.
(`--digest` already prints the full cert-failure lines instead of a digest header.)

## The digest (the DEFAULT output since 2026-07-13; FOUR-FIELD BULLETS since 2026-07-16 v3)
`render_board.py --digest` — ONE four-field bullet one-liner for EVERY actionable
section, cold included. Operator format interview 2026-07-16 v3 (chosen from
previews after two table iterations missed; supersedes v2's 3-col table): the
operator's exact spec is "lead + name of the lead · snippet of our last
communication, them or us · date of our last nudge · how many nudges sent
without reply, if applicable — that's all I need to know." NO tables — bullets
pre-wrapped at 64 cols, 2-space hang (the any-width legibility rule applies
again now that tables are gone):
```
• key [⏸→date] [⚠bounced] [🔵] [· contact@] — them/us <date> “snippet ~110”
  — nudged <date> [· N no reply] [· touch N of 3 | final touch]
```
- **lead + contact** — company key, then the lead's person as `localpart@`
  (who wrote last when they hold the ball, else `people[0]` — display names
  don't exist in the corpus index; the mailbox IS the deterministic name;
  omitted when it would repeat the key, e.g. bare-gmail leads).
- **them/us + snippet** — who holds the ball (engine `them_last`, never
  re-derived) · the date · that side's last message (~110 chars).
- **nudged <date>** — date of our last outbound; `never written` on
  first-contact rows.
- **N no reply** — nudges sent without a reply (engine unanswered streak),
  ONLY when we hold the ball and N>0 ("if applicable" — them-last rows carry
  no count).
- Safety marks on the key: `⏸→<date>` operator hold with wake date ·
  `⚠bounced` last send never arrived · `🔵` cold lead. Pinged-tray rows keep
  their `⚠ replied <date> … after frozen <date>` tail.
- DIGEST-DROPPED (still in full ledger + cockpit drill-down): the last-3-sends
  ledger, quiet-day counts, from-them unanswered counts, `awaiting them` /
  `they hold the ball` fillers. On COLD rows only, the touch-ladder token
  survives — `touch N of 3` / `final touch` — because it defines what the next
  GO means.
- Sections: **NEED REPLY** (owe + owe-review + first-contact) · **YOURS PERSONALLY**
  (operator-owned, automation off) · **FOLLOW-UP DUE** (cadence floor reached) ·
  **IN FLIGHT** (awaiting them + operator holds, sorted by wake date) · **COLD
  FOLLOW-UP DUE** (most-overdue first, same bullet as every other section).
  MEETINGS strip above when any exist.
- Everything else — cold exhausted, dead addresses, institutional, proposed
  closes, frozen — stays ONE `REST` tally line.
- The digest derives from the SAME canonical view and may never say more than the
  ledger, only less. Archivist advisories, promises/debts, and operator notes do NOT
  render in the digest — they live in the full ledger and the per-lead drill-down.

## Drill-down (when the digest under-tells)
- Operator says "full", "full board", or asks for detail on the whole field →
  run `render_board.py` (no flag) and print the FULL-GRANULARITY LEDGER verbatim.
- One lead → `python3 $VELAB/workspace/tools/thread_read.py <addr>` (the thread)
  and/or print that company's single ledger block from the full render — never a
  freehand summary of it.
- Cold-DUE worklist rows render in BOTH surfaces since 2026-07-16 (digest =
  the four-field bullet + `touch N of 3`/`final touch`; full ledger = full
  lines with contact + due-since); exhausted stay behind
  `--freeze-proposals`.

## The full ledger (render_board.py with no flag — the drill-down surface)
LEDGER BLOCKS since 2026-07-07 (operator call after the phantom-send audit) — the wide
6-column tables wrapped illegibly. Since 2026-07-09 (operator call: legible at ANY
terminal width, quarter-screen up) every markdown line is PRE-WRAPPED at 64 cols —
continuation lines keep the `│` gutter — and section headers are BOLD-DIVIDED:
`### **LABEL** (n)` on its own short line, plain descriptor line below.
FULL-GRANULARITY LEDGER since 2026-07-09 (operator verdict after the five-auditor
sweep: never under-tell — clips were amputating 66% of every Archivist advisory,
notes were a bare count, touches rendered nowhere). Markdown serialization only;
`--json` strings stay canonical. Each company = one block:
```
─ **company.key 📅scheduled …** · in Jul 6 2026 / out Jul 3 2026 · fresh · 📝2
│ sent 10 · replies 5 · quiet 2bd · next due Jul 13 2026
│ them (who@addr): “their last line, FULL gist (engine caps ~280),
│   wrapped at 64 cols with the gutter kept on continuations”
│ us (Jul 3 2026): “our last reply, full gist”
│ ⚠️ owed since their ask, never sent: <deliverables>   (only when owed)
│ ⚠️ we promised: <full commitment text>                (fresh verdicts only)
│ ⚠️ send BOUNCED <date> (<addr>) — never arrived        (spam-folder DSN proof)
│ frozen <date> by <who>: <full freeze reason>          (frozen rows only)
│ 📝 Jul 6 2026 (kind): full operator note text          (one line per note)
│ → engine action · Archivist: FULL advisory   (or “⚠️ CONFLICT — engine: … · Archivist: …”)
│ Archivist (advisory): …   (held/personal/parked/wait rows: advisory renders
│                            subordinate — the directive outranks it, no CONFLICT)
```
Header freshness tag (symmetric on EVERY section since 2026-07-09): `fresh` =
Archivist verdict current · `verdict STALE` = thread moved since the verdict
(advisory hidden) · absent = no verdict. Engine vs Archivist are NEVER merged into
one string; a `none — ball theirs` advisory against a live engine action renders
as ⚠️ CONFLICT — read the thread before acting on either. New engine fields
2026-07-09: `replies_count`, `next_due` (cadence floor date, persisted),
`bounces` + `spam_inbound` (the corpus now sweeps [Gmail]/Spam — DSN bounces and
misrouted lead replies are no longer invisible; junk can never mint a company).
- Cert line first, always. On quick certs a second line shows the age of the last
  FULL (live-IMAP) cert — quick is circular vs the corpus shards; >26h = stale warning.
  The nightly `velab-integrity.timer` (06:15Z) re-derives + full-certs + stamps it.
- **📅 Meetings strip** — upcoming / rescheduling / outcome-due only, with invite-sent
  status. The ONE allowed duplication: strip rows also appear in their section below.
- **🔴 REPLY NEEDED** — they wrote last, unanswered (buckets owe + owe-review).
- **🤝 IN YOUR HANDS** — operator-personal directives (automation off, inbound still
  surfaces here; V4.2). Includes existing CUSTOMERS (audit 2026-07-08).
- **⏸ HELD** — operator holds with their return date; a reply voids the hold (Delta rule).
- **🔔 NUDGE DUE** — cadence floor reached. Operator cadence (2026-07-03): in-flight
  (they've replied at least once) 2 business days · promised-revert 5 · cold ladder 3.
  Post-meeting silence → owe/meeting-outcome-due the day after the meeting.
- **⏳ IN-FLIGHT** — awaiting them, not yet due.
- **🔴 COLD** — tally line + the DUE companies as rows (`touch N of 3 due · last out ·
  quiet Nbd · due since · ⚠️ BOUNCED` — full-granularity 2026-07-09); exhausted stay
  behind `--freeze-proposals` (their action is a freeze decision, not a nudge).
- **🏛️ INSTITUTIONAL** — parked, never nudged, NEVER frozen (Licitador's lane).
- **🟠 PROPOSED CLOSES** — operator-gated via `close_company.py`; nothing suppressed by
  the proposal itself.
- **🧊 Frozen** count line only (rows with `--frozen` — implemented; sourced from
  board.json's `suppressed_engaged`).
- **⚠️ FROZEN LEAD WROTE BACK** (`operator_frozen_pinged`) — the exception to the
  frozen-is-invisible rule. A frozen/closed/dnc lead that replied AFTER its
  suppression with a live signal (ask_info/meeting/question/opening) is surfaced
  LOUD at the top of the digest. The freeze STAYS ON (the row is not back in the
  actionable funnel); it is shown so the operator can unfreeze-and-work it or
  re-freeze. This is the acme-labs.example.com fix (2026-07-14) — the tray the v2 rewrite had
  dropped, now rebuilt and Auditor-enforced.
- **📊 Snapshot** — counts + suppression classes + cert mode/time.
One row per company. Partition order: personal/held carved out first, then
REPLY > CLOSE-OUT > NUDGE > IN-FLIGHT (matches render_board.py — doc corrected 2026-07-08).

## Reading a row
- The action line is derived from engine state; `Archivist: …` is the LLM read and
  appears ONLY when not stale (thread unchanged since the verdict). Operator notes
  in `notes[]` (via `lead_note.py`) OVERRIDE Archivist prose — the `📝N` marker on
  the block header tells you notes exist; read them on any contested row before acting.
- Email-level DNC = SEND block only (audit 2026-07-08): DNC'd contacts' mail still folds
  into company history and their replies still surface — DNC never erases a company.
  The certifier cross-checks the cadence ledger's monotonic `replied` flags against the
  board every run (a ledger-replied company still in cold = a lost/out-of-universe reply).
- SEND-BOX TRUTH (2026-07-07 audit): `out` dates count ONLY messages present in
  Enviados. All-Mail carries Borradores, so staged-then-purged drafts used to
  masquerade as sends (11 phantom last_out dates, cold-due 18 vs the true 43).
  Both truth.py and certify.py now enforce this on independent paths.
- When a gist under-tells, open the thread: `python3 $VELAB/workspace/tools/thread_read.py <addr>`.
- Store durable facts: `python3 $VELAB/workspace/tools/lead_note.py --domain <key> --kind <kind> --note "<fact>"`.
- **Operator says "freeze X"** → the ONE writer is
  `python3 $VELAB/workspace/tools/freeze_lead.py --domain <key> --company "<name>" --reason "<why>"`
  (`--unfreeze` reverses; `--list` shows registry). NEVER hand-edit
  `operator-frozen.json` — the tool is idempotent, stamps `frozen_on`/`by`,
  and marks the board dirty so the cockpit re-derives. Added 2026-07-10.

## Flags / surfaces
- `--digest` — the compact digest (THE /inbox-check default since 2026-07-13;
  richer since 2026-07-16: cold-due table included).
- (no flag) — the full-granularity ledger; the drill-down surface, printed on "full".
- `--frozen` — markdown adds the frozen/closed ledger blocks (history kept, never worked).
- `--freeze-proposals` — markdown appends the cadence-exhausted cold companies as a
  reviewable freeze-proposal list (operator-gated; nothing auto-freezes). Added 2026-07-08.
- `--json` — the canonical view object; the cockpit's `/api/board` serves it verbatim
  plus the write-layer (decisions, journeys, mtimes). Never hand the console anything else.
- Cockpit redesign 2026-07-03: the console renders this view as a two-pane inbox
  (list = the spine's sections with human labels; right pane = the FULL conversation
  via `core/thread_dump.py`, grouped by company key — fork-proof vs Gmail THRID splits,
  calendar notices tagged). Classifications and action strings stay VERBATIM from the
  view; only the layout differs from this command's ledger blocks.

## Invariants (audited 2026-07-03)
- The engine NEVER filters on read/opened (\Seen) status — the operator opening mail
  in Gmail changes nothing here.
- Suppression (spam / probe / dnc / inbound-only / frozen / closed) = counts; 'test' is
  deliberately NOT suppressed (operator ruling 2026-07-04 — test identities ride the board)
  only; engine-classed at derivation. Email-level-DNC-erased companies are named in
  `cert.warns`. A confirmed close RE-OPENS on a later live-signal inbound (Delta rule).
- Frozen and departed-contact leads are never surfaced as rows or re-nudged —
  EXCEPT a frozen/closed/dnc lead that writes back after its freeze with a live
  signal, which surfaces in the `operator_frozen_pinged` tray (freeze stays on;
  never re-nudged automatically). A qualifying reply that is NOT in the tray is
  an Auditor-caught defect (acme-labs.example.com class, 2026-07-14).
