# VenusOS V2 (Valence) — Master Deployment Plan

> **Sanitized copy of an internal design document.** Identifiers, paths, and
> operational specifics have been removed or replaced with placeholders for this
> public showcase. Kept for its architecture and agent-contract design.

**Status:** PLAN, not live. Authored + reviewed in `$VELAB/VenusV2/`; ships to live as a
deliberate, separate step. Nothing in here runs yet.
**Last updated:** 2026-06-23.
**Resume handle:** say "resume venus v2".
**Why this file exists:** the single, self-contained, deployment-ready record of the VenusOS V2
agent rebuild. It lives in the vault (`$VAULT/os/`) because the vault is the only
thing pushed OFF-SERVER (a private backup repo). The node source files live in
`$VELAB/VenusV2/os/agents/` but that path is captured ONLY in on-server snapshots — so
this file is written to be complete on its own. If VenusV2 were lost, this plan + the
transferable scripts are enough to rebuild the chart.

---

## 1. What this is

A ground-up rebuild of the VenusOS agent layer for Velab (US-brand lab-equipment sales into
LatAm + US + Tier-1 pilot markets). The old system (OpenClaw → "Venus OS", planetary agent
names) was torn down 2026-06-20 and the VPS now runs from `$VELAB/`. V2 rebuilds the
agents from scratch, **role-named** (the planet analogy is dropped), one agent at a time.

Design principles, fixed:
- **Files are the kernel.** Agents coordinate through files, not a live message bus. The
  central agent reads + surfaces; it never relays in the hot path. If the runtime is down,
  events accumulate on disk; nothing is lost.
- **Role-named agents.** Workers get evocative role nouns (the Archivist, the Scraper…). The
  central command agent gets a lab-flavored proper name echoing Velab: **Valence**.
- **Ship from staging.** Work is authored in `VenusV2/`, then a node is copied into the live
  vault + wired to systemd as a separate, deliberate step. Only SCRIPTS transfer from the old
  system; agent STRUCTURES are rebuilt, never carried over.
- **Each agent sole-writes one realm** (a vault dir). It reads others' realms; it writes only
  its own (carve-outs are declared explicitly).
- **The sandwich doctrine** (every agent): deterministic skeleton/gates on the ends, the LLM
  only in the middle, and the LLM's output is never trusted until a deterministic pass clears
  it. "Present, never trigger" — an agent surfaces; it does not fire irreversible actions.
- **Token spend is opt-in.** Deterministic legs run free + always; the LLM legs spend only on
  the operator's standing decision (a live read) or an explicit request.

---

## 2. The node standard

Every agent is a directory `os/agents/<id>/` containing:
- **`AGENT.md`** — persona · realm · doctrine · hard boundaries. YAML frontmatter:
  `name, tagline, color, glyph, workspace` (the realm dir). Body is clear English; the agent's
  runtime VOICE is caveman mode (compressed, full technical accuracy) unless told "normal mode".
- **`CONTEXT.md`** — a "where truth lives" cheat-sheet (question → file) + the toolchain it
  drives + a DON'T list.
- **`HEARTBEAT.md`** — the agent's owned processes (systemd units), each with a **success-check**
  the Nightkeeper enforces (fired-in-window · exit-0 · artifact-fresh).
- **`processes/*.prompt.txt`** — the headless-LLM prompt files for its LLM legs.

A process ships only if it has: a systemd unit + a HEARTBEAT entry + a declared success-check.
"No process exists without a unit, a heartbeat, and a proof."

---

## 3. Comms backend (`VenusV2/os/COMMS.md`)

Two file-based layers, both append-only newline-JSON (atomic O_APPEND writes):
- **LOGS** (machine-first, per-agent): `vault/os/logs/<agent>.jsonl` + `vault/os/logs/system.jsonl`.
  Event: `{id, ts, from, kind:activity|issue|alert|status|ack, severity, subject, body, ref,
  needs_ack}`. Immutable + event-sourced (a status change is a NEW line referencing the original id).
- **CHAT** (conversational, org-wide, one shared file): `vault/os/chat/org.jsonl`.
  Message: `{id, ts, from, to, text, ref}`. Renders as a chat stream in the console later.
- A critical LOG event also drops a CHAT line (with `ref` = the log id) so it surfaces
  conversationally. Valence tails these and surfaces `to:venus`/high-severity events to the
  operator; severity is the hook for the operator-notify channel (push/console/email — wired later).

---

## 4. The roster

Built nodes are in `VenusV2/os/agents/<id>/`. Each summary below is complete enough to
reconstruct the node.

### 4.0 Valence — central command  ·  BUILT  (color #c9a227, glyph V, realm `os`)
The operator's single interface and the org's command center. It reads + surfaces + routes;
it is command, NOT a live message bus (state lives in files + timers, not in Valence's memory —
restart loses nothing, it re-reads the files).
- **Name rationale:** "valence" = an atom's combining capacity, the power to bond with
  everything around it — the central agent bonds the whole roster and command radiates out.
  Carries the V of Velab. Replaces the old agent name "Venus." (Whether the SYSTEM keeps the
  name "VenusOS" is a separate, still-open call.)
- **Dispatch model:** holds two GENERATED directories — the AGENT directory
  (`os/registry/agents.json`: each agent's id/role/realm/processes, aggregated from every node's
  `AGENT.md` + `HEARTBEAT.md`) and the SKILL/command directory (`os/registry/skills.json`). Given
  an operator task, the dispatch leg picks the owning agent + process + inputs, emits a DISPATCH
  PLAN, and fires it via the Task tool (V1 SDK-subagent model). One task can fan to several agents
  in sequence. Directories are generated-from-source, never hand-edited (same discipline as the
  Nightkeeper's registry).
- **Present, never trigger (enforced):** NEVER sends, drafts, stages, or GRANTS a send; never
  bypasses an agent's gate stack; never infers approval (the 2026-06-05 scar). For anything that
  touches the customer it dispatches the Mailman to DRAFT + STAGE and STOPS at the operator's
  verbatim grant. Reversible reads/rollups it may fire on the operator's ask (the standing
  opt-in). Token spend is opt-in — no autonomous LLM schedule; the only LLM leg is dispatch,
  fired per operator request.
- **Comms surfacing:** `valence-tail` (always-on, 0-LLM) tails `os/logs/*.jsonl` +
  `os/chat/org.jsonl`, forwards `to:venus`/high-severity to the operator-notify channel (backend
  now, push/console/email later), refreshes its own freshness stamp (the Nightkeeper watches the
  watcher). It never relays agent-to-agent chatter as a hot-path bus.
- **Realm (sole writer):** `os/` (the runtime, `os/registry/`, comms surfaces) — minus the agent
  nodes and the shared append logs (which it only reads; it appends to chat as `from:venus` like
  any agent).
- **Processes:** `valence-tail` (always-on, 0-LLM, surface comms), `valence-registry`
  (scheduled, 0-LLM, regenerate the agent + skill directories from the nodes), `valence-dispatch`
  (interactive LLM leg, `processes/dispatch.prompt.txt` — route + fire the owner, never grant).

### 4.1 The Archivist — source of truth  ·  BUILT  (color #3a6ea5, glyph A, realm `archivist`)
Owns how the org SEES its inbox. THREE responsibilities:
1. **The inbox READ** — pulls rep@example.com, reconciles, presents. The read is a
   sandwich: (a) DETERMINISTIC SKELETON (threading via Message-ID/In-Reply-To/References, cc's,
   directions, times, attachment MIME — measured, never guessed); (b) LLM COMPREHENSION (reads
   every letter; every claim cites a real message-id; no citation = not a claim); (c)
   DETERMINISTIC VERIFY (a claim that contradicts the skeleton is quarantined + flagged, never
   promoted). A read becomes truth only after verify; nothing downstream fires off it.
   - **Record** per company (`records/<domain>.json`): a small CLOSED SPINE of fixed enums
     (stage · ball-in-court · signal-type · meeting-status · next-action-type · lead-type ·
     intent-temperature · blocker · relationship-health · product-interest · language · country
     · channel), each with an `other:<free>` hatch that auto-promotes into a living glossary; +
     an OPEN BODY (summary, observations[], next-action prose, cited commitments ours/theirs).
   - **Company-level truth** (the sibling-address rule): reconciled across every address/thread at a
     domain (a cc-only reply from a sibling address is still a reply). Ball-in-court defaults to
     the most-recent message; the read may override with a cited reason (autoresponder, freight
     aside, courtesy cc), logged + auditable.
   - **What it reads/skips:** reads the WHOLE thread both directions incl. our sent mail; reads
     almost everything (autoresponders + bounces are real signals, labeled not dropped); drops
     ONLY DMARC/aggregate reports + email-warmup traffic (anchored on the warmup code — 
     mention of a person's name is never grounds to drop), and LOGS every drop.
2. **The company-wide JOURNALS** — curates org memory. `journals/activity/` (factual operational
   timeline, system + business side by side) and `journals/learnings/` (lessons/rules from
   audits + troubleshooting + the operator's "store learnings" command). Raw `journal.jsonl` is
   append-only multi-source; the Archivist owns the curated `<journal>.md` rollup. **Learnings
   are CONSULTED, not just stored** — the drafter reads the learnings rollup before writing.
3. **The CADENCE LEDGER** (operator-decided 2026-06-21) — the master email-tracking list:
   `vault/pipeline/cadence/ledger.json` + `schedule.md`, a CARVED sub-realm inside Mailman's
   `pipeline/` that the Archivist alone writes (it is a reconciliation, the Archivist's nature).
   Regenerated (never hand-edited) by reconciling Mailman's `sent/` records against inbound
   reply truth: `touches` = COLD-* sends only; `frozen` = touches ≥ 3; `due` = last cold send +
   3 business days inclusive; states replied/non-cold/dnc/bounced from inbound + suppression.
   **This is the org's ONE freeze/due computation** — Mailman gates on it, the Steward builds its
   picture from it, and NO other agent re-derives it. Atomic write (tmp + replace).
- **Realm (sole writer):** `archivist/{records,threads,glossary,runs,dropped,journals,INBOX-STATE.md}`
  + the carved `pipeline/cadence/`.
- **Processes:** `archivist-watch` (always-on IMAP IDLE → drop-filter → debounce → enqueue
  changed thread), `archivist-read` (queue-gated headless `claude -p`, the LLM sandwich → record
  + glossary + run log; token-bounded to changed threads), `archivist-sweep` (hourly backstop +
  watcher self-heal), `archivist-cadence` (scheduled + after each send, 0-LLM ledger regen).
- **Hard boundaries:** never send/draft/stage; never write outside `archivist/` + the carved
  `pipeline/cadence/`; a flag is information never a trigger; citation-required.

### 4.2 The Nightkeeper — declared-vs-actual reconciler  ·  BUILT  (#6a5acd, glyph N, realm `nightkeeper`)
Keeps the system honest: every process ran, ran on time, ran correctly.
- **The one idea:** compare what the system SAYS should be true vs what IS true, raise the gap.
  Cron: declared = every node's HEARTBEAT units; actual = live systemd. Bounding (future):
  declared = each agent's `workspace:` realm; actual = who actually wrote files; gap = an agent
  writing out of scope. The registry is GENERATED by aggregating every HEARTBEAT, then cross-
  checked against reality.
- **"Ran correctly" = three-part check:** fired-in-window · exited-clean (status 0) · produced
  its expected artifact, fresh. Each job declares the success-check slot in its HEARTBEAT; the
  Nightkeeper holds + runs it, it does not invent the criteria.
- **Hybrid, always-on:** a deterministic tick (rebuild registry, run checks, write status, refresh
  its own freshness stamp) that NEVER depends on the LLM — if it stops, the stamp goes stale and
  that staleness is the alarm (who-watches-the-watchdog). An LLM brain wakes only on a CONFIRMED
  break to diagnose + write a troubleshoot note + escalate.
- **Pause is an outcome, never a reflex:** act only on confirmed-broken (repeated miss / non-zero
  exit / failed artifact). A protective `systemctl stop` only when troubleshooting concludes the
  job is harmful or looping; a paused job stays down until a human clears it. NEVER auto-fix,
  auto-restart, or auto-resume.
- **Realm (sole writer):** `nightkeeper/{registry.json,status.json,STATUS.md,heartbeat.stamp,runs,troubleshoot}`.
- **Processes:** `nightkeeper-tick` (always-on, 0-LLM), `nightkeeper-brain` (flag-gated headless).

### 4.3 The Scraper — targeted lead sourcing  ·  BUILT  (#b06f43, glyph S, realm `leads`)
Brings NEW leads in. Works named SEAMS = `(category × country)` veins, never the open internet.
- **Two axes (operator's model):** **WIDTH** = open/widen seams via discovery (find new sources,
  ICP/geo-gated, deduped vs the claim map). New ground needs JUDGMENT → an LLM act → a live pass.
  **DEPTH** = tunnel within a source via subpaths (`--max-subpaths`) + tier-escalation, and
  REVISIT of vetted sources (deterministic, schedulable). The claim map (`source_registry.json`)
  remembers what was mined, when, and what it yielded so WIDTH never re-discovers worked ground
  and DEPTH never re-scrapes inside the revisit window. **Exhaustion is the signal to widen.**
- **Funnel (sandwich):** discover (0-token metasearch + ICP token gate + geo gate + claim-map
  dedup) → qualify+JUDGE (qualify.py pulls EVIDENCE not a score; LLM decides which to dig + how
  deep) → scrape (tiered, tunneled) → verify (Reacher) → gate+dedup → land.
- **Verification honesty:** four strengths, never collapsed to one "verified": **hard** (SMTP-safe
  / role inbox carved on catch-all), **carve** (risky-but-institutional role inbox / relaxed-MX),
  **defer** (greylist → `deferred/`, not the yield), **rej** (invalid/disposable/DNC/free-no-affil).
  Catch-all flagged not trusted; hard-valid fraction is small (~7%) and the run summary carries
  all four counts.
- **Realm (sole writer):** `leads/{raw,verified,rejected,deferred,audit,system/*,discovery-stats,LEADBOOK.md}`.
  Reads geo-allow + DNC (read-only law).
- **Processes:** `scraper-pass` (operator-triggered, the WIDTH pass w/ live LLM judgment;
  detached + done-file + single-run guard + Reacher preflight + render cap), `scraper-deepen`
  (scheduled 0-LLM revisit), `scraper-reverify` (scheduled 0-LLM greylist re-probe),
  `scraper-seam-scan` (scheduled 0-LLM exhaustion + recommend-widen). OPEN: scheduled sourcing
  is a departure from the old "no sourcing cron" — confirm or keep only `scraper-pass`.

### 4.4 The Mailman — drafts + sends outbound mail  ·  BUILT  (#9c3d54, glyph M, realm `pipeline`)
The only agent that touches the customer. Two acts: DRAFT and SEND. Sits at the END of a chain
it does not control (Archivist surfaces truth → operator decides who/whether → Valence dispatches
→ Mailman decides HOW). It decides the words, the thread, the clean stage; it never decides who or
whether to contact.
- **Doctrine (sandwich, gate stack):** classify → draft (LLM) → cadence gate → recover threading
  (from the Sent box) → static thread gate → review cards (HARD: crosswiring/replied-suppression/
  DNC/dedupe; WARN: voice/format/subject) → adversarial CONTENT REVIEW (LLM, down-to-the-character)
  → stage to Gmail Borradores → [operator reviews] → live thread gate → grant (operator verbatim)
  → send → purge the staged twin → log. A HARD fail is a wall.
- **THE SEND-AUTH GATE (the spine, default-DENY):** no message transmits unless the recipient is
  covered by a valid operator ticket (`outbox/send-approvals.json`: recipient-scoped, time-boxed,
  single-use, not revoked). A grant requires the operator's VERBATIM words via the grant tool
  (`--operator-approval "<quote>"`); the harness hook blocks self-grant + direct approvals-file
  edits. No env bypass. Daily cap 50/UTC-day. Reputation kill-switch (`send-pause.json`) honored.
  NEVER send on inference (the 2026-06-05 scar: three unrecallable emails sent on a comment that
  was not a send order).
- **Voice discipline:** never freelance cold copy — match the approved corpus (`reference/
  draft-examples/*` + sent mail). BANNED: "genuinely"/"truly", "American-made" in the body, any
  finality ("one last time"/"por última vez"/"cerrando el seguimiento"), referral-asks ("point me
  to the right person") EXCEPT the onus-on-us redirect ("if we've reached the wrong person…"),
  weak CTAs used as the ask, two stacked "quedo…" lines. CTA strength is STAGE-SCOPED: COLD-01 +
  replied/engaged = direct time-boxed ask; COLD-02/03 to a non-replier = SOFT, request nothing,
  push no file; COLD-03 reads as a normal follow-up, ZERO finality. Clean company names (never a
  raw domain; trust the domain on a name mismatch). Gender-correct ES greetings (Estimada / Estimado
  / neutral team). No unsolicited files. No emojis.
- **Fact discipline:** Velab is an American BRAND, not a US manufacturer — never "American-made" in
  a body, never certify origin / Buy-American / TAA (the cold signature "fabricante americano" is
  the only approved brand line); any origin/TAA question is a HARD HUMAN GATE to the operator; no
  named-competitor-brand claims.
- **Threading discipline (most-failed area):** anchor = the LAST message in the thread (their reply
  if answered, our last send if cold); anchor from the Sent box NEVER All-Mail (draft immunity —
  the 9/50 split); an in-thread/established reply KEEPS the thread's exact subject (changing it
  splits the Gmail thread — the THRID_SPLIT scar); client unthreaded → reply fresh (no forced
  anchor); order = recover threads FIRST then judge subject; bulk threaded sends get a canary.
- **Staging discipline:** Borradores is pending-only — purge the staged twin after a send (match a
  `sent/` record by recipient + normalized subject, never similarity, compare vs the Sent box only).
- **Realm (sole writer):** `pipeline/{drafts,sent,outbox,reputation,send-ledger.json}` + Gmail
  Borradores staging. READS the Archivist's records + the cadence ledger (gates on it, never writes
  it), `reference/` voice + geo-allow, suppression + DNC.
- **Processes:** `mailman-draft-stage` (operator-triggered, craft + gate + stage, NEVER sends),
  `mailman-send` (operator-triggered, gated, transmit + purge twin + signal the Archivist's cadence
  regen), `mailman-reputation` (scheduled 0-LLM bounce/complaint watch → trip the kill-switch,
  never auto-resume), `mailman-borradores-sweep` (scheduled 0-LLM pending-only safety net). NO send
  cron by design — sending is never autonomous; the scheduled units are guards, never originate mail.

### 4.5 The Steward — owns the CRM  ·  BUILT  (#3f7d6a, glyph S*, realm `clients`)
Holds the org-wide pipeline picture and turns truth into a prioritized worklist. It is NOT a fourth
reader of truth — it's the AGGREGATION + DEAL-STATE + ACTION layer ON TOP of the other realms.
- **Reads, never re-derives:** inventory (how many leads/verified/by-country/by-type ← the Scraper's
  `leads/` registry), cadence (emailed/frozen/due ← the Archivist's ledger — read its verdict,
  never recount touches), conversation (replied/who-owes/what-was-promised ← the Archivist's
  records — never opens the mailbox; the old CRM read only its own dossiers and reflected nothing
  of two months of real conversation — be a read-time join over the Archivist's truth).
- **Owns the gap no one else fills — the DEAL layer:** `clients/` dossiers (a DEAL OVERLAY that
  JOINS the Archivist record; auto-sections generated, only grades/notes/quotes hand-owned) +
  `meetings/` + generated `clients/PIPELINE.md` (the org-wide roll-up = every count the operator
  needs, each traced to its source plane) + generated `clients/WORKLIST.md` (the prioritized
  action list).
- **Tenets are CONSUMED, never re-coded:** the 3-nudge freeze (read `status:frozen`/`due_date` from
  the ledger), geo boundaries (`reference/geo-allow.json`, the single source of truth), DNC, the
  deal-stage ladder (outreach → replied → meeting → quote-sent → won/lost/dormant; upgrade-only;
  won/lost/dormant are operator grades, never overwritten). Re-coding a tenet = the old
  console-vs-ledger drift bug.
- **Worklist buckets:** DUE · OWE-REPLY · MEETING-FOLLOWUP · QUOTE-FOLLOWUP · THAW (frozen-no-reply
  + the ~138 dormant reactivation set) · DATA-GAPS/GEO · DECLINED (surfaced to EXCLUDE, never
  re-nudge). Deterministic backbone + an opt-in LLM ranking leg that honors CLIENT PARTICULARITIES
  (a client who asked us to wait until July is not "due"; a big institution mid-procurement
  outranks a thin lead).
- **PRESENT, NEVER TRIGGER:** produces a picture + worklist; does NOT dispatch Mailman, grant a
  send, or fire anything. The operator reads the worklist, decides, prompts Valence; Mailman acts
  on approval.
- **cartero_intel splits:** comprehension (thread → verdict) → the ARCHIVIST; deal-application
  (`--apply`: materialize `meetings/` files + advance the dossier stage from the verdict) → the
  Steward.
- **Realm (sole writer):** `clients/` + `meetings/`. Reads leads/, the cadence ledger, the
  Archivist's records, geo-allow, DNC.
- **Processes:** `steward-rollup` (scheduled 0-LLM, chained AFTER the ledger + records settle:
  join planes → PIPELINE.md counts + worklist backbone; run `crm_sync.py` + `cartero_intel.py
  --apply`), `steward-prioritize` (LLM opt-in, ranks by particularities → narrative WORKLIST.md).
- **Note:** glyph "S" currently collides with the Scraper's — cosmetic, reassign on ship.

### 4.6 The Bidder — US public-procurement bids  ·  BUILT  (color #2c8a93, glyph B, realm `rfps`)
Owns the *solicitation* from appearing on a US portal to an apply-ready package at the submit
button. A discover → qualify → assemble engine; it ENDS at `assembled/` and hands off — the
operator submits, the Steward owns the procurement relationship + win/loss outcome. Renames the
old "Licitador"; reuses its surviving scripts (`workspace/skills/rfp-analysis/`) + realm
(`vault/rfps/`, intact) + the `/licitador` skill, but the STRUCTURE is new and built **against v1's
failures** (operator 2026-06-23: "a better system based on the learnings and failures, not a port").
- **Why a rebuild:** v1 ran live a week and surfaced ZERO real bids — all false positives ("balance"
  → an HVAC "test and balance" job; a brand-locked BRUKER ITB; point-of-care ultrasound). Five named
  failures → five fixes baked into the node:
  1. v1 leaned on the WEAKEST discovery (scrape one list + keyword-match) while the high-signal feed
     was never wired → **mailbox-first, portal taxonomy first:** register saved searches keyed to
     NIGP/NAICS on DemandStar/SAM.gov/TX-ESBD; their alert emails are the spine; scrape only the
     FL/GA entity-page tail that doesn't alert. Until the mailbox + registrations exist, it runs the
     tail scraper alone and SAYS SO in every digest (the same blocker that kept v1 at zero).
  2. v1 qualified bids into a pipeline that could never move (VELAB never registered to submit) →
     **eligibility is the FIRST gate, before catalog fit.** A perfect fit we can't submit is
     `blocked:<reason>` with an operator REGISTRATION PROMPT, never an "actionable" qualified item.
  3. v1 re-learned the same false positive daily (a digest proposed the TAB/HVAC fix; nothing
     systematized it) → **feedback loop:** a confirmed false-positive class-signature is promoted
     into `disqualifier-signatures.json` (deterministic), and each source carries a precision stat.
  4. v1 over-built the lifecycle (8 state dirs, 3-agent handoffs) for ~0 real items → **lean:**
     `raw → qualified → assembled`, then stop. submitted/won/lost is the Steward's overlay.
  5. v1's LLM triage burned attention on garbage → **precision-gated triage:** the code-anchored
     screen is strong enough the LLM only sees genuine ambiguity; empty queue = zero tokens.
- **Scope (operator-fixed):** **US ONLY, by design** — VELAB bids in the US (fairer process); bids
  elsewhere go through a distributor with local ties. TX/FL/GA + US federal where registered. Mexico
  + all non-US excluded. Catalog-strict (microscopes/centrifuges/balances/spectrophotometers/pipettes
  + accessories), $2,500 floor, open specs only (brand-locked → reject).
- **Apply boundary (operator-fixed):** "apply" = **assemble to the submit button**, never past it.
  NEVER submit / sign / pay / register / certify origin-TAA-set-aside / finalize a price. A submitted
  bid is a priced binding legal offer — the most irreversible act in the org; the human commits.
  Pricing is PROPOSED from the reference list, operator finalizes every number.
- **Realm (sole writer):** `vault/rfps/` THROUGH `assembled/` only (`raw/ → qualified/ → assembled/`
  + `system/{bidder-config,seen,monitor-queue,triage-state,portal-directory,source-quality,
  disqualifier-signatures,registration-status,vendor-kit/}`). Reads geo-allow + DNC + vendor-kit +
  pricing reference (law). Contributes lessons to the Archivist's learnings journal.
- **Processes:** `bids-monitor` (scheduled 0-LLM — mailbox ingest + tail scrape → prefilter → queue),
  `bids-triage` (queue-gated headless LLM — judge → packet/reject + digest, empty = 0 tokens),
  `bids-deadline-watch` (scheduled 0-LLM guard — surface ≤7-day deadlines, never acts), `bids-assemble`
  + `bids-register-prep` (operator-triggered, no unit — assemble to boundary / prep registration,
  never execute). Node = `VenusV2/os/agents/bids/` (AGENT/CONTEXT/HEARTBEAT + processes/{triage,
  assemble}.prompt.txt).
- **Standing dependency (operator action):** wire a notification inbox + do the one-time portal
  registrations & NIGP/NAICS saved searches — that turns the mailbox spine live.
- **BUILD PROGRESS (2026-06-23, step-a scripts reshaped + TESTED, not shipped to systemd):**
  - SOURCE MAPS = the Bidder's real spine. The FL/GA/TX maps (`$VELAB/inbox/source-map-*.xlsx`,
    ~4,900 US public entities) carry a per-row procurement profile. The operator's model:
    an institution is ONE record with possibly TWO "doors" — a DIRECT door (informal procurement →
    a normal lead, Steward/Scraper/Mailman own it) and a BID door (RFP portal → the Bidder). Not
    fixed; an institution can have both, discovered on contact. Nobody owns the institution identity;
    the Bidder owns the BID DOOR, the Steward owns the relationship. Built from the maps:
    `vault/rfps/monitoring/targets.jsonl` (4,661 bid-door institutions, 896 portal-verified) +
    `monitoring/portal-directory.json`. Platform concentration = **BuyBoard dominates**, then a
    `standalone-page`/`CivicPlus` SCRAPE TAIL, then mailbox-registerable aggregators (DemandStar,
    IonWave, Bonfire, BidNet, PublicPurchase, OpenGov, Jaggaer) — so the spine = a handful of
    registrations, confirming mailbox-first.
  - `rfp_prefilter.py` REBUILT to the doctrine: CODE-ANCHORED catalog match (reads the real
    `data/commodity_codes.json` NIGP/NAICS/UNSPSC→velab map; catalog vs off-catalog vs service),
    SIGNATURE kills (`system/disqualifier-signatures.json`, seeded from v1's real FPs), and an
    ELIGIBILITY-first verdict (`system/registration-status.json`, keyed by platform). TESTED on v1's
    actual false positives: HVAC "test and balance" → rejected (signature), point-of-care ultrasound
    → rejected (signature), BRUKER brand-lock → rejected; a real microscope bid (175-49) → candidate;
    centrifuges on BuyBoard → candidate + `blocked:not_started` (eligibility gate = registration prompt).
  - `rfp_monitor.py` REBUILT: MAILBOX-first ingest (`--source mailbox --maildir` of .eml alerts →
    parse → screen → queue) + ESBD scrape as the TAIL + `system/source-quality.json` per-source
    precision + honest "mailbox spine DARK" logging until registrations exist. TESTED end-to-end with
    synthetic DemandStar/BidNet alerts: catalog bid queued (blocked-on-registration), HVAC FP killed.
  - NOT YET: systemd units for bids-monitor/triage/deadline; the LLM triage + assemble legs; a live
    notification inbox. New `system/seen.json` (src:id keyed) supersedes the old `esbd-seen.json`
    (old dedupe history not carried — one-time re-surface on first live esbd run, easily reconciled).

### 4.7 Planned, not yet built
- **Service** — post-sale / customer care (the old "Portero"; realm `service`). The old service
  inbox was Outlook (basic-auth POP dead) — needs a forward-to-Gmail or Azure-OAuth wiring.
- **Auditor** — data-integrity checker (distinct from the Nightkeeper's job-health and the
  Archivist's inbox read): is the STORED data correct/consistent across planes. **BUILT
  2026-07-14** (`core/auditor.py`) after the acme-labs.example.com loss proved the gap: re-derives truth
  from the corpus plane and cross-checks the persisted board + the rendered view. Fails LOUD
  (alerts → `state/audit.json` → top of /inbox-check digest and the console board banner;
  non-zero exit on a critical, so a timer marks the failure instead of it going silent the
  way integrity.py did). Invariants: no suppressed-but-hot lead missing from the
  `operator_frozen_pinged` tray or dropped by a renderer; registry-load health (fail-open
  guard); DNC/dead-mailbox cold leaks; board/corpus freshness; surfaces integrity.py's phantoms.
  Runs in the /inbox-check pipeline (truth → certify → auditor → render) and the console regen.
  **PARITY ENGINE + LLM TRIAGE BUILT 2026-07-14.** `core/parity.py` is the deterministic,
  genuinely-independent (raw live IMAP vs raw corpus, never `derive()`) deletion-aware mirror
  check: bidirectional — corpus-only mids = deletions (inert draft-twin / acknowledged junk /
  active real, sub-tagged in_trash vs hard_deleted), live-only mids on claimed-covered days =
  coverage gaps the mirror under-reported. Persists `parity.json` + a presence snapshot; found
  and (after a targeted re-pull) closed a real gap on first run (2 vendor spam replies un-mirrored
  on two dates). `core/deletion_triage.py` is the sanctioned LLM-in-cron layer: event-triggered on
  parity's `new_active` deletions ONLY, headless `llm -p` (Archivist idiom, zero tools, flock,
  poison-pill), classifies junk vs real-lead and PROPOSES an action to an operator tray — never
  auto-acks, never gates. Wired: `velab-parity.timer` every 30 min → `parity_cycle.sh`
  (parity → triage); the Auditor reads `parity.json`/`deletion-triage.json` and flags active
  deletions (critical if hard-deleted), coverage gaps, a stale parity guard, and pending triage.
  Deletion ledger = `phantom-acknowledged.json` (`phantom_audit.py --ack`). The sales read-copy
  mailbox (sales@example.com) is a DOCUMENTED unmonitored blind spot (separate IMAP/POP box, no
  creds here); the engine
  is account-list-driven so it drops in as a second mirror the moment creds exist. Alerts route
  through `audit.json` (digest + console banner) since no systemd OnFailure channel exists.
- **Sentinel** — cybersecurity guard (bindings, lockdown posture, public-listener allowlist,
  fail2ban, secrets perms).

---

## 5. Operator decisions on record (with rationale)
1. **Ground-up rebuild, role-named** — drop the planet analogy; rebuild agents from scratch; only
   scripts transfer, never agent structures.
2. **Central agent name = Valence** (chemistry: combining/bonding capacity = binds the org; V of
   Velab). System name "VenusOS" kept for now (separate, open).
3. **Two files per company, not one** (2026-06-21): the Archivist's `record` (conversation truth)
   and the Steward's `dossier` (deal overlay that joins the record). Avoids two agents writing one
   file — the historical bug source.
4. **The cadence ledger is owned by the ARCHIVIST** (2026-06-21): reconciliation is its nature; it
   is the org's one freeze/due computation; Mailman + Steward read it, never write it. Mailman
   writes `sent/` records + signals the regen.
5. **Tenets consumed, never re-derived** — the freeze rule, geo-allow, DNC, the deal ladder each
   have ONE owner of the computation; everyone else reads. (Re-coding caused console-vs-ledger drift.)
6. **Present, never trigger** — agents surface; the operator decides; only the operator (via
   Valence → Mailman, behind the send-auth gate) sets irreversible actions in motion.
7. **The Mailman loop:** operator reviews the Archivist's truth → prompts Valence → Valence
   dispatches Mailman → Mailman drafts + stages → operator approves verbatim → Mailman sends.

---

## 6. System laws / shared tenets (every agent honors these)
- **Freeze rule:** 3 cold touches → frozen; 3 business days (inclusive) between cold steps. Cold
  sequence = COLD-01-INITIAL → COLD-02-FOLLOWUP → COLD-03-FINAL, then freeze. `touches` counts
  COLD-* only. Computed once, by the Archivist's cadence ledger.
- **Geography:** `vault/reference/geo-allow.json` is the SINGLE source of truth — 22 countries
  (US + 17 LatAm + Tier-1 pilots UAE/South Africa/India/Philippines). **Mexico permanently
  excluded** (parent-company exclusive territory). Geography is PROVEN from the domain (ccTLD) or
  an in-country signal — NEVER inherited from a batch label (a mislabeled-batch incident). LOCKSTEP
  WARNING: opening a country here is not enough — the pattern guards (`FOREIGN_VENDOR_TLDS`,
  `NON_ICP_DOMAIN`/`NON_ICP_PHONE_CC`) must be edited in the same change (today India is allowed
  but `.in` is still rejected — a known gap).
- **DNC:** `reference/dnc-domains.md` (operator-canonical) + `suppression/dnc.jsonl`. Read as law;
  domain + subdomain match; checked before any contact or send.
- **Deal ladder:** outreach → replied → meeting → quote-sent → won/lost/dormant. Upgrade-only;
  won/lost/dormant are operator grades automation never touches; no downgrades.
- **Send-auth:** default-DENY; operator verbatim approval ticket; hook blocks self-grant; no env
  bypass; cap 50/UTC-day; reputation kill-switch.
- **Voice & facts:** approved-corpus-only cold copy; the banned-words list; stage-scoped CTA;
  clean names + gender-correct greetings; no unsolicited files; American BRAND not US manufacturer
  (origin/TAA = hard human gate); brand-specific bids off-limits.
- **No emojis** anywhere in the system (console, vault, agent output) — monochrome text/glyphs only.
- **Role inboxes are valid leads** (ventas@/info@/contacto@/gerencia@ at real domains) — the
  primary B2B channel, not low-quality fallbacks.

---

## 7. Lead-to-deal lifecycle (how the agents chain)
```
Scraper  →  lands verified leads in leads/
   │
Mailman  →  cold-sequences them (draft → gate → stage → operator-approved send)
   │            writes sent/ records
Archivist → reads every reply, reconciles company truth (records/), regenerates the
   │            cadence ledger (frozen/due), curates the journals
Steward  → joins inventory + cadence + conversation into the pipeline picture (PIPELINE.md)
   │            + the prioritized worklist (WORKLIST.md); owns deal state (clients/, meetings/)
Valence  → surfaces the picture/worklist to the operator; on the operator's order, dispatches
              the right agent (Mailman to reply/follow-up, Scraper to source/thaw, Bids for an RFP)
Nightkeeper → in parallel, verifies every scheduled job fired + fired right; escalates breaks
```
Orders flow DOWN from Valence; truth flows UP through the files. Valence is command, not a bus.

---

## 8. File inventory + transferable scripts
- **Node sources (plan):** `$VELAB/VenusV2/os/agents/{archivist,nightkeeper,scraper,mailman,
  steward}/` + `VenusV2/os/COMMS.md` + `VenusV2/{README.md,RESUME.md}`.
- **Realms (live vault dirs the nodes will own):** `archivist/` (new), `nightkeeper/` (new),
  `leads/`, `pipeline/` (Mailman) + carved `pipeline/cadence/` (Archivist), `clients/` + `meetings/`
  (Steward). Shared read-only law: `reference/geo-allow.json`, `reference/dnc-domains.md`,
  `suppression/`.
- **Transferable scripts (live, in `$VELAB/workspace/`):**
  - Sourcing (in the `leadgen` skill `~/.claude/skills/leadgen/tools/`): `source_discovery.py`,
    `qualify.py`, `scrape_orchestrator.py`, `scrape_contacts.py`, `crawl4ai_extract.py`,
    `camoufox_extract.py` (BROKEN — NSS too old), `verify_email.py`, `source_registry.py`;
    `process_leads_batch.py`, `lead_guards.py`, `leadbook.py`. Reacher @ `localhost:8080`.
  - Mail: `inbox_view.py`, `thread_read.py`, `inbox_audit.py`, `cadence_gate.py`, `thread_gate.py`,
    `subject_gate.py`, `recover_threads.js`, `verify_drafts.py`, `verify_draft_threading.py`,
    `stage_drafts_in_gmail.js`, `smtp.js`, `grant_send.py`, `send_gate_hook.py`,
    `reconcile_sendbox.py`. Skills: `imap-smtp-email`, `velab-stage-drafts`.
  - CRM: `crm_sync.py`, `cartero_intel.py` (+ `cartero_prompt.txt`), `hubspot_sync.py`
    (push-only; vault = truth), `hubspot_pull.py`.
  - Slash commands (`~/.claude/commands/`): `draft.md`, `inbox-check.md`, `stage-drafts.md`.

---

## 9. Deployment approach (ship a node, live, as a separate step)
For each agent, when ready:
1. Copy `VenusV2/os/agents/<id>/` into the live OS agents location.
2. Create its realm dir(s) in the vault; declare the sole-writer (and any carve-out).
3. Write its systemd unit(s) per HEARTBEAT, with the success-check; register it so the Nightkeeper
   picks it up (the registry is generated from HEARTBEATs).
4. Point the LLM legs at their `processes/*.prompt.txt`.
5. The runtime (Claude Agent SDK, as in V1) loads each `AGENT.md` as a subagent def; Valence
   dispatches via the Task tool. Build Valence's node first among the unbuilt, since it is the
   entry point.
6. Verify: run each deterministic leg once, confirm the artifact + freshness, then enable timers.
Ship order suggestion: Valence → then the rest as their realms are ready. Mailman ships LAST or
behind an extra-careful check (it is the only irreversible actor).

---

## 10. Open items / next steps
- **Valence's node is BUILT** (2026-06-22) — §4.0. OPEN decisions surfaced for the operator:
  (a) does Valence own an operator-notify CHANNEL impl now or stay backend-only; (b) the
  generated registries (`os/registry/agents.json` / `skills.json`) — confirm the format on ship;
  (c) glyph "S" still collides between Scraper + Steward (cosmetic, reassign on ship).
- **The Bidder's node is BUILT** (2026-06-23) — §4.6. OPEN: wire the notification inbox + the
  one-time portal registrations/saved searches (the standing dependency that turns the mailbox spine
  live); reconcile the surviving scripts (`rfp_monitor.py`/`rfp_prefilter.py`) to the new doctrine
  (mailbox-first ingest, eligibility-first gate, signature-feedback) before shipping.
- **Build the remaining roster:** Service, Auditor, Sentinel.
- **Confirm:** scheduled sourcing legs for the Scraper (departure from "no sourcing cron"), or keep
  only the operator-triggered `scraper-pass`.
- **Fix the India geo lockstep gap** (allowed in geo-allow but `.in` still in FOREIGN_VENDOR_TLDS)
  before India goes from pilot to real.
- **Camoufox Tier-3** is broken (NSS < 3.101, no FF binary) — stay on Tiers 1+2 or do the real fix.
- **Service inbox wiring** (Outlook → Gmail forward or Azure OAuth) before the Service node is real.
- **Spec the `store learnings` command** + the operator command layer.
- **Decide** whether the SYSTEM keeps the name "VenusOS" or also renames (the agent is Valence).

## 11. Durability note (ACTION for the operator)
The off-server GitHub backup (`velab_vault_push.sh`) pushes ONLY `$VAULT/` (+ workspace
skills). `$VELAB/VenusV2/` is captured ONLY in on-server snapshots (`velab_backup.sh` Part B,
to `$VELAB/backups/snapshots/`). So this master plan (in the vault) IS off-server; the VenusV2 node
SOURCES are not. To make the node sources off-server too, add `$VELAB/VenusV2` to the push
script's rsync set (or relocate VenusV2 under the vault). Until then, treat this file as the durable
record and re-sync it whenever a node changes.
