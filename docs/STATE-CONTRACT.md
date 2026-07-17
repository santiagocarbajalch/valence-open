# VELAB STATE CONTRACT — one home per state, one writer per home

> **Sanitized copy of an internal document.** Identifiers and operational
> specifics have been removed or generalized for this public showcase; the
> state-ownership architecture is preserved.

Created 2026-06-10 (P1 of the Velab-OS roadmap). This is the authoritative map of
**operational state**: where each piece lives, which tool may WRITE it, who reads it,
and how to regenerate it. Rule of the house: **every state file has exactly ONE
writer**; everything else reads. If you find a second writer, that's a bug — fix it,
don't add a third.

## Tier 0 — external truth (not files)

| State | Truth | Read via | Notes |
|---|---|---|---|
| What was actually sent | **Gmail Sent box** (`[Gmail]/Enviados`) | `inbox_view.load_sent()` | "Send box = truth" doctrine (2026-06-05). NEVER count All-Mail — it contains staged drafts. |
| What leads replied | Gmail All-Mail inbound | `inbox_view` live refresh | Replies attach to leads by exact address, then domain (non-freemail only). |

## Tier 1 — derived caches (regenerable; safe to delete, expensive to lose freshness)

| File | Writer (ONLY) | Readers | Regenerate | Staleness rule |
|---|---|---|---|---|
| `pipeline/cadence/engaged-domains.json` | `inbox_view.py` (live run only) | `cadence_gate.py` | live `/inbox-check` | gate WARNS if as_of >3d (P0 2026-06-10); degraded runs print DEGRADED banner |
| `pipeline/cadence/ledger.json` + `schedule.md` | `inbox_audit.py` (auto-run post-send) | console, operator, /stage-drafts display | `python3 tools/inbox_audit.py` | regenerated each send; never hand-edit ("112 phantom follow-ups" incident) |
| `pipeline/cadence/reply-state.json` | `inbox_audit.py` | `inbox_view.py` (fallback) | same | monotonic cache; live IMAP read supersedes |
| derived fields in `leads/verified/*.json` (`outbound_count`, `inbound_count_*`, `thread_state`, `last_*_at`, `indexed_at`) | `leadbook.py --refresh` (CLI, canonical since 2026-06-10); console `inbox-index.js` also writes on console activity (legacy, same lineage) | `inbox_cadence_drain.mjs`, console cadence-engine/followups, candidate-list builders | `python3 tools/leadbook.py --refresh` (also emits `leads/LEADBOOK.md`) | CACHE, not truth — derived from ledger + inbox/threads. Readers check `indexed_at`; `leadbook.py --check` reports staleness. Went 8d stale 06-02→06-10 when operator moved off console. |
| `leads/LEADBOOK.md` | `leadbook.py` | operator (Venus vault), agents needing the lead universe cheap | `python3 tools/leadbook.py` | generated view, never hand-edit; joins live ledger so it's fresh even when lead-file cache isn't |

## Tier 2 — records (append-only; backfilled from Tier 0, never invented)

| File | Writer (ONLY) | Readers | Notes |
|---|---|---|---|
| `pipeline/sent/*.json` | senders (`send_followups_threaded.py`, `send_batch.py`); backfill by `sync_system_from_sendbox.py` / `reconcile_sendbox.py` | smtp.js idempotency, verify_drafts dedupe, cadence_gate **fallback only** | Partial mirror of the Sent box (starts 05-19). Cadence math reads the Sent box, NOT these. |
| `pipeline/send-ledger.json` | `smtp.js` | `smtp.js` | Daily send-cap counter (50/UTC-day). **NOT a duplicate of cadence/ledger.json** — different purpose. |
| `pipeline/audit/gate-runs-<date>.jsonl` | `gate_audit.py` (via the 3 gates) | operator, debugging | One verdict line per gate run (P0 2026-06-10). |
| `pipeline/console-approvals/`, `pipeline/outbox/send-approvals.json` | operator grant flow (`grant_send.py`) | smtp.js default-DENY gate | Send-auth gate — agent may NEVER write these. |

## Tier 3 — work-in-flight (created → consumed → archived)

| Location | Writer | Consumer | Lifecycle |
|---|---|---|---|
| `/tmp/draft-pack-*.json` | `/draft` (candidate) | the 3 gates | gated in /tmp; moved to vault ONLY on all-clear (P0 ordering fix) |
| `pipeline/drafts/*.json` | `/draft` (post-gate move) | `/stage-drafts` | a pack here has ALWAYS passed the static gates |
| `inbox/threads/*.json` | inbox tooling | tier2, console | canonical per-lead thread state |
| `inbox/tier2/*.json` | Tier-2 classify (console, paused build) | console buckets | LAYER over threads (verdicts) — same filename ≠ same content; NOT a duplicate |
| `inbox/orphan-replies/*.json` | inbox tooling | operator review | LAYER: replies from un-mailed addresses at contacted domains |
| `pipeline/{approvals,disapprovals,handoffs/*,jobs/runtime,template-sidecars}` | console routes + drain tools (`licitador_drain.py`, `inbox_cadence_drain.mjs`) | console | empty ≠ orphan — live queue dirs, keep them |

## Tier 4 — operator-maintained policy (humans write, tools read)

| File | Readers | Notes |
|---|---|---|
| `reference/dnc-domains.md` | inbox_view, leadgen verify, /draft | canonical domain-level DNC |
| `suppression/dnc.jsonl` | verify_email, gates | email-level DNC. KNOWN GAP: dual-read with the .md, no consistency check — P2+ item |
| `reference/reply-triage.md` | /draft classification | spec drift undetected — keep in sync by hand |
| `reference/draft-examples/` | /draft (golden voice) | grows on operator approval of new (type × lang × stage) |

## Known remaining violations (the P2+ punch list)
1. **DNC dual-source** (.md domains vs .jsonl emails) — consolidate to .jsonl, auto-generate the .md.
2. **`pipeline/queue.md`** (54K, last touched 06-01) — hand-maintained master tracker, overlaps ledger/schedule. Candidate for retirement once console covers it; do not extend it.
3. **`.bak` litter** — 83 files archived to `vault/.archive/2026-06-10-p1-bak-cleanup.tar.gz` and removed. The pre-index .bak writer lived OpenClaw-side (idle since 06-02); if .baks reappear after a runtime restart, find and fix that writer.
4. **Vault leads/raw naming** — heterogeneous (`batch-` prefix vs bare dates); standardize to `<date>__<category>__<geo>` on next leadgen pass, don't mass-rename history.

## Addendum 2026-06-10 — full process-I/O audit (corrections + coverage)

Audit traced every command (/draft, /inbox-check, /stage-drafts), skill (/leadgen,
/licitador), live loop (rfp-monitor, rfp-triage, vault-sync, email-scheduler), send tool,
and both consoles to exact reads/writes. Corrections to the text above:

**Corrections**
- Punch-list #3 is WRONG about the .bak writer: it is `velab-console
  server/services/inbox-index.js:377` (`.bak.pre-index-<ts>` into `leads/verified/`) and
  velab-console.service is ACTIVE — .baks WILL reappear on console inbox-index runs.
  `tools/vault_sweep.py` now sweeps them; the real fix is removing that copyFile.
- `pipeline/console-approvals/` writer is `velab-console sendgate.js:200`, NOT the
  operator grant tool (which writes only `outbox/send-approvals.json` + `send-audit.log`).
- `outbox/send-approvals.json` has a sanctioned SECOND writer: `smtp.js:204` marks
  tickets used. Operator grants; smtp consumes. Both intended.

**Open two-writer violation (fix needs operator GO — send path)**
- `pipeline/cadence/schedule.md`: contracted writer is inbox_audit.py (regenerator), but
  `send_batch.py:229` also rewrites it in place (and `send_batch.py:200` rewrites
  `pipeline/queue.md`). Edits get clobbered on next regen. Proposed fix: delete
  send_batch's schedule.md/queue.md write paths; it already emits sent-records and
  inbox_audit regenerates schedule truth.

**Uncontracted state families (writers live, now documented here)**
- rfps/ (Licitador/Mars): `system/{monitor-queue.jsonl (APPEND, checkpoint-consumed via
  triage-state.json), esbd-seen.json (REGEN dedupe), monitor.log + triage-cron.log
  (APPEND), triage-digest-<date>.md (daily), licitador-config.json +
  registration_status.json + vendor-kit/* (OPERATOR)}, lifecycle dirs
  raw→qualified→applying→submitted/terminal (agent moves, operator-gated).
- leads/ leadgen (Pipeline/Mercury): `system/{source_registry,lead_registry}.json
  (registries, in-place), discovery-stats.jsonl (APPEND), raw/batch-* (REGEN per batch;
  READ by inbox_view — never sweep non-empty), rejected|audit|deferred (EXHAUST),
  jobs/ (EXHAUST, write-only), leadbooks/ (REGEN).
- `pipeline/scheduled/*.json` state machine + `pipeline/sent/scheduled-*.json` —
  writer `process_scheduled_emails.mjs` (velab-email-scheduler.timer).
- Misc: `cadence/pending-actions.jsonl` (inbox_audit), `cadence/action-tree.yaml`
  (OPERATOR rules), `cadence/manual_replies.json` (OPERATOR), `management-handled.json`
  (OPERATOR), `outbox/send-audit.log` (APPEND), `reputation/send-pause.json`
  (reputation_monitor.py), `reference/scoring.yaml` (OPERATOR policy), console-only
  state under `inbox/{incoming,orphan-labels}/`, `pipeline/{operator-overrides,
  scrape-requests,handoffs}/`, `os/mirror/**` (hourly rsync REGEN).

**New tier: EXHAUST.** One-shot run artifacts no process reads back. Swept by
`tools/vault_sweep.py` (age-gated, archives to `.archive/sweep-*.tar.gz` with manifest,
refuses live-writer paths). First sweep 2026-06-10: 276 files / 9.4 MB.

## Addendum 2026-06-11 — guard + service domains (Venus-only routing)
- `audits/custodio/{latest.json,REPORT.md}` — sole writer `tools/custodio_check.py`
  (velab-custodio.timer hourly + console /api/integrity/run). REGEN, never hand-edit.
  Saturn/Custodio writes its own dated investigation notes beside them in `audits/`.
- `vault/service/**` — sole writer `tools/pop_monitor.py` (velab-pop-monitor.timer,
  disabled until creds): `raw/*.eml` + `inbox/*.md` (APPEND-once per message),
  `INBOX.md` (REGEN per poll), `state/{seen-uidl.txt,status.json,poll.log}` (poller
  internal). Exception: Neptune/service agent may edit `triage:`/`summary:` frontmatter
  in `inbox/*.md`. Mail is NEVER deleted server-side or in raw/.
- Console chat routing: agents in `os/agents/` are SDK subagents of the Venus session
  (server.mjs sdkAgents) — personas there are now part of the runtime contract.

## Addendum 2026-06-12 — durable CRM + heartbeat (operator mandate)

| state | sole writer | readers | notes |
|---|---|---|---|
| `clients/*.md` mail-derived lines (`(auto-sync)` log bullets, `Last contact`, Status upgrades from `outreach`) | `workspace/tools/crm_sync.py` (velab-crmsync.timer, 4h, after velab-leadstate) | console `/api/crm`, Jupiter | Append-only into `## Interaction Log`; never rewrites operator/Jupiter lines; explicit Status grades never touched. Jupiter + operator (console) remain the writers of everything else in the dossier. |
| `audits/security/latest.json` | `workspace/tools/security_check.py` (velab-security.timer, daily + console button) | console `/api/security`, Pluto | Read-only on the whole system otherwise. |
| timer liveness (`velab-*` units) | `custodio_check.py check_heartbeat()` — may `systemctl start` a DOWN timer (self-heal), nothing else | Saturn, console integrity panel | The heartbeat: expected-cadence table lives in the script; pop-monitor excluded until armed. |

Cadence chain every 4h: `velab-leadstate` (:40, ledger regen from mailboxes) →
`velab-crmsync` (:55, dossiers from ledger truth). `velab-custodio` (hourly) verifies
both fired. DNC dossiers do not live in `clients/` — relocated to `vault/suppression/`
(macro-search moved 2026-06-12); DNC truth stays `reference/dnc-domains.md` + `suppression/dnc.jsonl`.

## Addendum 2026-06-12b — thread intel (the Vega fix)

| state | sole writer | readers | notes |
|---|---|---|---|
| `inbox/intel/threads/*.txt` + `manifest.json` | `cartero_intel.py --collect` (deterministic, IMAP read-only) | LLM stage, Saturn | Hash-gated: a thread re-queues only when content changed. |
| `inbox/intel/verdicts/*.json` | velab-cartero.service LLM stage (`claude -p` + cartero_prompt.txt) | `--apply` | Facts-only extraction; bounded to this dir. |
| `meetings/<status>/*.md` (intel-created) + `clients/*.md` `(intel)` lines / intel-owned Next action / Status ladder upgrades | `cartero_intel.py --apply` (deterministic) | console, Jupiter, operator | Append-only log discipline; operator-written Next action is never overwritten; Status only upgrades outreach→replied→meeting→quote-sent. |

Chain at 04/16h UTC: leadstate :40 → crmsync :55 → cartero :10 (+05/17h). Heartbeat
covers velab-cartero (14h window). This closes pending-actions `requires_cartero_llm`
— flagged replies now actually get content-classified.

## Addendum 2026-07-12 — reconciliation with disk reality (agent-file audit, operator GO)

Corrections to claims above that no longer hold on disk:

- **`clients/` is DEAD-WRITE (legacy).** `crm_sync.py` was retired to
  `workspace/tools/_archive/`; `velab-crmsync.timer` no longer exists; `cartero_intel.py`
  only READS `clients/` (its `(intel)` write path is gone). No genuine writer since
  ~2026-06-11. `companies/` (truth-engine, domain-keyed) is the live company realm.
  The 06-12 CRM addendum rows describing `clients/*.md` writers are historical record only.
- **Index layer restored 2026-07-12.** `vault_index.py` and `leadbook.py` were retired
  ~06-13/06-17 and the whole generated-index layer (root INDEX.md, 6 domain INDEX.md,
  LEADBOOK.md, CLIENTBOOK.md) froze for 29 days. Both tools are back in
  `workspace/tools/` and now run 4x/day from `velab_backup.sh` (Part A2), so every
  snapshot and off-server push carries fresh indexes. `companies/INDEX.md` remains
  truth-engine-owned (`core/pages.py`, velab-integrity.timer) and is always freshest.
- **`vault_sweep.py` is retired** (also in `_archive/`); the EXHAUST-tier sweep it owned
  has NOT run since 2026-06-10. Retention is now `velab_janitor.py`
  (velab-janitor.timer, daily 04:40, hard-coded family whitelist) + `/etc/logrotate.d/velab`.
  Vault-side EXHAUST sweeping is unowned until the janitor grows vault families or the
  sweep is revived — flagged, not silently reassigned.
- Dead/retirement suffix convention going forward: prefer `_superseded-YYYY-MM-DD/` dirs
  (ISO date) inside the realm; stop minting new `.removed`/`.DISABLED`/`.retired-*` variants.
