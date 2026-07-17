# Architecture philosophy

The README states these principles in brief. This document is the deep version:
each principle, why it exists, and where in the repository it is actually
enforced. This is the part worth reading if you care less about the sales use
case and more about how to build an LLM-operated system that stays trustworthy.

The whole design answers one question: **how do you put a large language model in
charge of real work without letting it quietly corrupt the state of the
business?** Every principle below is one answer.

---

## 1. No LLM in the runtime

**Rule.** Recurring work must reduce to deterministic code or an explicit
operator action. A model that reads the inbox "every morning" on a timer is
treated as a design failure. One-shot model work that produces a *code change* or
a *one-time judgment the operator asked for* is fine; a model sitting in a loop
making routine decisions is not.

**Why.** Deterministic code is reproducible, auditable, cheap, and cannot
hallucinate a company into the wrong stage. If the same inputs always produce the
same board, you can certify the board. If a model produces it, you can only trust
it. The system pushes every recurring decision down into `core/` so the model is
never load-bearing for correctness.

**Where.** The entire truth engine (`core/truth.py`, `core/identity.py`,
`core/certify.py`, `core/parity.py`, `core/render_board.py`) is plain Python with
no model call in the path. Production runs it on a fixed schedule via systemd
timers, not by asking a model to "check." The model is invoked only from explicit
console controls (draft, revise, investigate) and from one-shot commands the
operator runs by hand.

## 2. The send gate is default-DENY, and no model output is approval

**Rule.** The outbound path refuses to send unless a standalone, explicit
operator approval exists for that exact batch. Answering a question, printing a
draft, saying "looks good," or a model deciding a message is ready — none of
those is approval. Approval is a separate, deliberate act.

**Why.** Sending email is the one irreversible, externally-visible action in the
system. It is the action an operator most needs to stay in control of and the one
a confused or manipulated model could do the most damage with. So it is the one
authority never delegated. A common failure mode in agent systems is letting the
model's own confidence ("I've reviewed this and it's ready") stand in for human
sign-off; here that is explicitly defined as *not* approval.

**Where.** `console/src/lib/sendGuard.ts` implements the gate: recipient-scoped,
single-use grants, verbatim typed confirmation, cap and pacing. The doctrine's
tenet 24 ("the send gate is sacred") requires new features to route *around* the
gate — e.g. a calendar invite fires at the moment of approved send — rather than
through a weakened version of it. The API route under `console/src/app/api/send`
is where the server-side refusal lives; the UI only reflects it.

## 3. Company-level truth

**Rule.** The unit of the business is the registrable domain, not the email
address. A reply from any sibling address at a company counts as that company
replying. Cadence, stage, and "whose turn is it" are all computed at the company
level.

**Why.** People forward, cc colleagues, reply from a different address, or hand
off to a teammate. An address-centric system double-counts these as separate
leads and nags a company that already replied. Collapsing to the registrable
domain makes the state match how a human actually thinks about the account.

**Where.** `core/identity.py` derives the company key from the registrable
domain; `core/truth.py` computes state per company; the console mirrors the same
key in `console/src/lib/companyKey.ts`. The doctrine encodes it as tenet 22: "one
warm reply = one pack = one stage = one send approval."

## 4. External truth beats local caches

**Rule.** What was actually sent is whatever is in the mail provider's Sent box,
full stop. Local records are a partial mirror. When they disagree with the
provider, the provider wins.

**Why.** Any local ledger drifts — a crash between sending and logging, a manual
send outside the system, a partial sync. If you trust the local copy you
eventually act on a lie. Treating the provider as the sole source of send-truth,
and *continuously proving* the mirror rather than assuming it, is what keeps the
board honest over months.

**Where.** `core/parity.py` is a dedicated parity engine that checks the local
corpus against the provider (IMAP) on a schedule and flags divergence instead of
silently trusting the cache. It runs in production as its own timed service.

## 5. Adversarial certification and fail-loud auditors

**Rule.** The board the operator sees is not trusted just because a function
produced it. A separate certifier re-derives and challenges it. A separate
auditor cross-checks independent planes for contradictions and fails *loudly*
rather than degrading silently.

**Why.** A single code path can be confidently wrong. The cheap defense is a
second, independent derivation that has to agree. And when something *is* wrong,
the worst outcome is a system that hides it and keeps serving a plausible-looking
board — so the auditors are built to surface the failure where the operator
cannot miss it, not to paper over it.

**Where.** `core/certify.py` re-derives and certifies the board;
`core/auditor.py` is the cross-plane integrity guard; `core/integrity.py` and
`core/deletion_triage.py` back specific checks (mirror integrity, unexpected
disappearances). Production keeps history snapshots of the board so a regression
is diffable after the fact.

## 6. Plain files are the system of record

**Rule.** The durable state of the business lives in plain files in a vault —
Markdown dossiers, JSON registries, JSONL logs — not in a database the operator
cannot read. Operator decisions (freeze, close, do-not-contact, meetings, test
identities, set-aside) are durable vault files that survive every regeneration,
and the engine reads them as the *last word*.

**Why.** Plain files are inspectable by a human, greppable, diffable in git,
and equally readable by any model or tool. There is no schema migration and no
opaque binary state. "Registries are the memory" (doctrine tenet 21): UI state is
never the only place a decision exists, so a rebuild never loses an operator's
ruling. It also means the whole system of record can be version-controlled and
backed up as text.

**Where.** The vault layout is documented in
[`docs/VAULT-LAYOUT.md`](VAULT-LAYOUT.md) (the data itself is excluded from this
repo). Which process may write which state file is pinned in
[`docs/STATE-CONTRACT.md`](STATE-CONTRACT.md) — a one-writer-per-state map that
prevents two processes clobbering the same truth.

## 7. Wipe-guarded, git-backed durability

**Rule.** Off-server durability runs on a schedule: local snapshots plus a push
to a private mirror. A value-based secret scan aborts the push if anything
credential-shaped reaches the staging tree, and exclude rules keep secrets out of
the mirror by construction. A wipe-guard refuses to mirror a suspiciously empty
or shrunken tree.

**Why.** Backups fail in two silent ways: they stop running, or they faithfully
mirror a corruption/deletion. The scheduled cadence addresses the first; the
wipe-guard addresses the second. The secret scan exists because the same
automation that makes backups easy makes leaking a credential to a mirror easy.

**Where.** `ops/velab_backup.sh` orchestrates local snapshot + mirror;
`ops/velab_vault_push.sh` does the secret-scanning push. In production this runs
several times a day as a timer, alongside snapshotting and a push to a private
GitHub mirror.

## 8. A cross-model LLM shell (model-agnostic dispatch)

**Rule.** The LLM layer is provider-agnostic. Every model reaches the same
skills, commands, and shared memory through one dispatch point. Swapping the
model is a one-line configuration change; the skills, commands, and memory are
plain files any harness can read.

**Why.** Models change monthly. Tying the operating system to one provider's SDK
means rewriting it every time a better model appears, and it prevents different
models from cooperating on the same work. Routing every headless call through one
entrypoint makes the model a *replaceable part* rather than a foundation.

**Where.** `llm-shell/bin/llm` is the single headless dispatch point;
`llm-shell/backend.conf` is the one file you edit to point at a different model
or provider (it names the adapter, the binary, and an optional model id).
`llm-shell/START-HERE.md` is the orientation any model reads first; `commands/`
and `skills/` are plain-Markdown procedures the model executes; the memory
contract is likewise plain files.

## 9. Operator decides, agents work

**Rule.** A single human operator holds all authority that matters. Agents
propose; the operator decides. A console action carries the operator's approval
by the click, and an agent's concern is one advisory line, never a refusal — with
the single, permanent exception that *sending* always passes the full send gate.

**Why.** This is the social contract that makes the rest safe to automate.
Because the operator is unambiguously in charge, the system can let agents do a
lot of work without the work ever becoming an unaccountable decision. And because
the one dangerous action (send) is carved out of the "click = approval" rule, the
convenience of delegation never bleeds into the one place it must not.

**Where.** Doctrine tenets 24 and 29 state both halves. In code, the guards live
server-side in the API routes under `console/src/app/api/` (a plain-language
refusal, not a silent no-op), and `console/src/lib/chatGuard.ts` /
`console/src/lib/sendGuard.ts` enforce the boundaries the UI merely reflects.

---

## The shape of the whole thing

Put together, the principles describe a system where:

- correctness is deterministic and certified (1, 4, 5),
- the dangerous action is human-gated and un-delegable (2, 9),
- the state is plain, durable, single-writer, and backed up (6, 7),
- the human's mental model is the unit of truth (3), and
- the model itself is a swappable component, not the foundation (8).

A large language model is genuinely useful inside this — it reads replies, drafts
in the house voice, qualifies leads, runs audits that become new guardrails — but
it is never the thing you have to trust for the books to be right. That
separation is the entire design.
