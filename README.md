# Valence

An LLM-orchestrated outbound-sales operating system: a deterministic Python
truth engine, a Next.js operator console, a plain-file vault as the system of
record, and an LLM shell that gives any model the same skills, commands, and
memory contract.

> **Sanitized showcase.** This repository is a sanitized, extracted snapshot of a
> private production system that runs a real outbound-sales operation. All
> operational data (leads, clients, email threads, pipeline state, credentials,
> and infrastructure identifiers) has been removed or replaced with synthetic
> placeholders. The data-layer directories are documented (see
> [`docs/VAULT-LAYOUT.md`](docs/VAULT-LAYOUT.md)) but intentionally absent, and
> the live system runs from a separate private repository. This is published as
> a portfolio and architecture artifact, not a turnkey installable product.

## Demo

![Valence console — a tour of the Today, Pipeline, and Scraping tabs](docs/demo/demo.gif)

A ~27-second tour of the console running on synthetic fixture data (every
company and address is `*.example.com`). Stills: [Today](docs/demo/today.png) ·
[Pipeline](docs/demo/pipeline.png) · [Scraping](docs/demo/scraping.png). The
capture is reproducible: `console/tests/demo-tour.mjs` drives a fixtures-only
server (`COCKPIT_FIXTURES=1`) with Playwright.

![The vault rendered as a navigable 3D knowledge graph](docs/demo/vault.gif)

The vault rendered as a navigable 3D knowledge graph — every folder a star,
its files swarming around it (the console's Vault tab).

## What it is

Velab sells laboratory equipment and reaches distributors through an outbound
email pipeline. The interesting part is not the emailing; it is the operating
model around it:

- The **truth** of the business (who was contacted, who replied, whose turn it
  is to act, what stage each company is at) is computed deterministically from
  the mail provider, never guessed by a model.
- A model does the **judgment** work (reading a reply, drafting a response,
  qualifying a lead) but never the **bookkeeping**, and never sends anything on
  its own.
- A single human **operator** holds all authority that matters. Agents propose;
  the operator decides. Sending email is default-denied and requires an explicit
  per-batch approval that no amount of model output can substitute for.

The name "Valence" refers to the OS layer that coordinates the agents and the
memory they share.

## Design: a console a stranger could run

The console has one acceptance test that outranks every visual choice: **a
stranger with no context could sit down and run the business from it.** The
design doctrine states it literally — every user-facing sentence "reads like a
normal email tool a stranger could operate." Workflow words are fine (nudge,
stage, freeze, thread); machinery words are banned — no engine names, file names,
enum values, timestamps, or count-only shorthand. "If a stranger would ask 'what
does that mean?', it fails."

That rule is enforced, not remembered. A copy linter fails the build when
console-speak reaches a user-facing string, and every board-derived sentence is
generated in exactly one module (a "sentence factory") so the language stays
consistent as surfaces multiply. Four more tenets shape everything else:

- **No display-only features.** Every button, chip, and link does what it says,
  end-to-end, the day it ships. A control that only changes pixels is removed or
  finished — never merged as decoration. Its siblings: *count = filter* (if the
  number says 16, clicking it shows 16) and *controls never lie about scope*
  (a bulk button names the real count).
- **Refresh on activity, never on timers.** Data reloads because something
  happened — a mutation, newly detected mail — not because N seconds passed.
  Anything that spends model tokens fires only from an explicit click that states
  its cost; there is no always-on sidecar chat.
- **The rail classifies; the pane acts.** The left list files companies into
  groups and never funnels you into one action. Opening a company shows the full
  action set with the engine's reasoning beside it. "A classification is a
  suggestion, never a chute."
- **Weight follows the next step.** Exactly one primary button per pane — the
  recommended next action; destructive actions are never the loudest. Explainer
  prose hides behind a "?" so a surface reads as labels, not walls of text.

The current look ("FRONT OFFICE" — navy workflow sidebar, Hanken Grotesk + Red
Hat Mono) is the latest of roughly a dozen design eras, each recorded as one
paragraph in [`console/DESIGN-LINEAGE.md`](console/DESIGN-LINEAGE.md). The full
rule set is [`console/CONSOLE-DOCTRINE.md`](console/CONSOLE-DOCTRINE.md); the long
version of this section is [`docs/DESIGN.md`](docs/DESIGN.md).

## What the console is for

Everything the operator needs to run the day lives on **one desk** — one screen,
one authority, no swivel-chairing between tools:

- **Today board** — every company that needs a decision, filed into plain groups
  (owed a reply, gone quiet, close-outs, cold due, bid desk, added today, set
  aside). Counters double as filters into their exact rows.
- **Reply desk** — open a warm reply and the full action set is right there:
  draft with the model, revise in place, attach, stage, set a meeting, freeze,
  or close out — with the engine's reasoning shown beside each.
- **Pipeline** — the same companies partitioned into engine stages, for a
  portfolio view of where everything sits.
- **Mining** — lead sourcing and qualification, run on demand, landing verified
  leads into the vault.
- **Files / knowledge graph** — the vault rendered as a navigable map so the
  operator can see the system of record, not just query it.
- **Chat** — the model baked into the features that need it (draft, revise,
  investigate), never a detached assistant guessing at state.

This is an **operator console, not a SaaS CRM**, on purpose. A CRM stores what a
human types and trusts it; this console computes the truth from the mail provider
and shows the human a certified board. The operator's job is judgment and
authority — read the reply, approve the send — while the deterministic engine
does the bookkeeping a CRM would ask a human to maintain by hand.

## The system in production (aggregates as of 2026-07-17)

What the system has actually done, from the live private deployment, followed
down the funnel from a raw lead to a booked meeting. Every identifying detail —
names, domains, addresses, deal values, event-tied dates — is excluded by
construction; only the aggregate counts below are published.

| Stage of the work | Figure |
|---|---|
| Leads sourced | 1,601 |
| Leads verified (ICP + deliverability) | 742 |
| Companies contacted (at least one outbound) | 328 |
| People contacted (distinct addresses) | 353 |
| Outbound emails sent through the gated pipeline | 1,062 across 90 batches |
| — of those, follow-ups and nudges | 626 |
| Companies that replied | 46 |
| Meetings held (companies reaching the meeting stage) | 7 held (15 scheduled) |
| Procurement contacts mapped for public bids | 10,000+ across 3 US states (TX, FL, GA) |
| Countries / markets reached | 15+ (LatAm, US, SE Asia, Africa) |
| Do-not-contact requests honored | 389 |
| Engine + console size | ~4,100 lines of Python (deterministic engine) · ~16,900 lines of TypeScript (console) |
| Off-server durability | 4x/day mirror + snapshot + private push, 1,200+ commits |

Every figure was computed read-only against the private backup tree; each was
cross-checked against a second source where one exists (replies, for example,
reconcile the truth engine's board against the inbound thread transcripts), and
the conservative number was published when sources differed. Nothing beyond
these aggregates left the backup.

## Architecture

```mermaid
flowchart TB
    subgraph external["External truth"]
        gmail["Mail provider\n(Sent box + inbound)"]
    end

    subgraph engine["core/ — deterministic truth engine (no LLM)"]
        truth["truth.py\nderive company-level state"]
        certify["certify.py\nadversarial certification"]
        parity["parity.py\nIMAP-vs-corpus mirror check"]
        auditor["auditor.py\ncross-plane integrity guard"]
        render["render_board.py\nboard.json + digest"]
    end

    subgraph vault["File vault — system of record (excluded from this repo)"]
        state["state/ (board.json, reports)"]
        pipeline["pipeline/ (cadence, drafts, sent, approvals)"]
        leads["leads/ · inbox/ · companies/ · rfps/"]
    end

    subgraph shell["llm-shell/ — the LLM shell (Valence)"]
        memory["memory contract\n(cross-model)"]
        skills["skills/ (leadgen, licitador)"]
        commands["commands/ (draft, inbox-check, stage-drafts)"]
        dispatch["bin/llm + backend.conf\nsingle dispatch point"]
    end

    subgraph console["console/ — Next.js operator console"]
        board["board / cockpit"]
        sendgate["send gate (default-DENY)"]
        chat["embedded chat (Agent SDK)"]
    end

    operator["Operator (sole authority)"]

    gmail --> truth
    truth --> certify --> render
    parity --> render
    auditor --> render
    render --> state
    state --> console
    pipeline --> console
    leads --> console
    console --> operator
    operator -->|explicit "send"| sendgate
    shell -.reads/writes.-> vault
    console -.shells out to.-> engine
    console -.invokes.-> shell
    dispatch --> skills
    dispatch --> commands
```

The pieces talk through the vault. The engine writes state files; the console
reads them and shells out to the engine and to workspace tools; the LLM shell's
skills and commands operate over the same files. Nothing holds private state in
memory that isn't recoverable from the vault plus the mail provider.

## Architecture philosophy

These are the ideas worth studying; the code exists to enforce them. The full
treatment, with the reasoning behind each, is in
[`docs/PHILOSOPHY.md`](docs/PHILOSOPHY.md). They all answer one question: *how do
you put a language model in charge of real work without letting it quietly
corrupt the state of the business?*

- **No LLM in the runtime.** Recurring work must reduce to deterministic code or
  an explicit operator action. A model reading the inbox "every morning" on a
  timer is a design failure; a one-shot audit that produces a code change is
  fine. This keeps behavior reproducible, certifiable, and cheap. The whole
  `core/` engine has no model call in its path.

- **Send is default-DENY, and no model output is approval.** The outbound path
  refuses unless a standalone, explicit operator approval exists for that exact
  batch. Answering a question, printing a draft, or a model deciding a message
  "looks ready" is never approval. It is the one authority never delegated
  (`console/src/lib/sendGuard.ts`, the `api/send` route).

- **Company-level truth.** The unit of the business is the registrable domain,
  not the email address. A reply from any sibling address counts as that company
  replying; cadence and "whose turn is it" are computed per company
  (`core/identity.py`, `core/truth.py`, `console/src/lib/companyKey.ts`).

- **External truth beats local caches.** What was sent is whatever is in the
  provider's Sent box, full stop. A dedicated parity engine continuously *proves*
  the local corpus still mirrors the provider instead of assuming it
  (`core/parity.py`).

- **Adversarial certification, fail-loud auditors.** The board is not trusted
  because a function produced it; a separate certifier re-derives and challenges
  it, and an auditor cross-checks planes for contradictions and fails loudly
  rather than degrading silently (`core/certify.py`, `core/auditor.py`).

- **Plain files are the system of record.** Durable state is Markdown dossiers,
  JSON registries, and JSONL logs a human can read — not an opaque database.
  Operator decisions live in vault files the engine reads as the last word, and
  one-writer-per-state is pinned in
  [`docs/STATE-CONTRACT.md`](docs/STATE-CONTRACT.md).

- **Cross-model LLM shell.** The LLM layer is provider-agnostic: every model
  reaches the same skills, commands, and memory through one dispatch point, and
  swapping the model is a one-line change (`llm-shell/bin/llm`,
  `llm-shell/backend.conf`). The model is a replaceable part, not the foundation.

- **Wipe-guarded backups.** Off-server durability runs on a schedule with a
  value-based secret scan that aborts the push if anything credential-shaped
  reaches the staging tree, plus a guard that refuses to mirror a suspiciously
  emptied tree (`ops/velab_vault_push.sh`, `ops/velab_backup.sh`).

- **Operator decides, agents work.** A console action carries the operator's
  approval by the click; an agent's concern is one advisory line, never a
  refusal — with the single permanent exception that sending always passes the
  full send gate.

## Repository map

```
core/            Deterministic truth engine (Python, no LLM at runtime).
                 truth.py, certify.py, parity.py, auditor.py, render_board.py,
                 identity.py, archivist.py, integrity.py, and supporting modules.

console/         Next.js + TypeScript operator console.
                 src/app/api/*   server routes (board, send, drafts, meeting, ...)
                 src/components/  cockpit, pipeline, vault graph, activity log
                 src/lib/        send guard, company key, vault helpers, jobs
                 tests/          Playwright smoke test + synthetic fixtures
                 CONSOLE-DOCTRINE.md · DESIGN-LINEAGE.md · COCKPIT-V4.md

llm-shell/       The provider-agnostic LLM shell ("Valence").
                 START-HERE.md   orientation for any model pointed at the system
                 bin/llm         single headless dispatch point
                 backend.conf    the one place to swap model providers
                 commands/       draft, inbox-check, stage-drafts (Markdown procedures)
                 skills/         leadgen (lead sourcing), licitador (RFP/bid lifecycle)

ops/             Backup and off-server durability engineering.
                 velab_backup.sh       local snapshot + mirror orchestration
                 velab_vault_push.sh    secret-scanning push to a private mirror

docs/            Architecture documents.
                 DESIGN.md              the console design story, long version
                 PHILOSOPHY.md          the principles, with code pointers
                 VAULT-LAYOUT.md        the excluded data layer, described
                 STATE-CONTRACT.md      one-writer-per-state map
                 VENUSV2-MASTER-PLAN.md agent/kernel design spec
```

## What is not here, and why

- **The data vault.** The `state/`, `pipeline/`, `leads/`, `inbox/`,
  `companies/`, `clients/`, `rfps/`, and related directories are the live system
  of record and contain real third-party data. They are excluded by design and
  documented in [`docs/VAULT-LAYOUT.md`](docs/VAULT-LAYOUT.md).
- **Credentials and infrastructure identifiers.** No keys, tokens, private
  hostnames, or network addresses. Code that needs a root path, a sending
  identity, or a self-domain reads it from an environment variable with a
  placeholder default.
- **Session history and memory.** The cross-model memory *contract* is described,
  but the memory store (real operational notes) is not included.

Because of this, the code is presented for reading, not for one-command
deployment. Standing it up would require providing a vault of the documented
shape and real provider credentials.

## Sanitization

Every included file was scanned and sanitized: real people, companies, email
addresses, domains, phone numbers, credentials, and network identifiers were
removed or replaced with `example.com`-style placeholders and synthetic data.
Test fixtures were rebuilt as fully synthetic data. The production figures in
"The system in production" are aggregate counts only, computed read-only against
a private backup with all identifying data excluded. See `docs/VAULT-LAYOUT.md`
for the data model and the individual documents' sanitization notes.

## License

MIT. See [`LICENSE`](LICENSE).
