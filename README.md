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

## Design principles

These are the ideas worth studying; the code exists to enforce them.

- **No LLM in the runtime.** Recurring work must reduce to deterministic code or
  an explicit operator action. A model that reads the inbox "every morning" is a
  design failure. One-shot audits that produce code changes are fine; a model in
  a loop making routine decisions is not. This keeps behavior reproducible and
  cheap.

- **Send is default-DENY.** The SMTP path refuses to send unless a standalone,
  explicit operator approval exists for that specific batch. Answering a
  question, printing a draft, or saying "looks good" is never approval. The
  approval is a separate act, gated in code (`console/src/lib/sendGuard.ts`,
  and the approvals contract in the state layer).

- **Company-level truth.** The unit of the business is the registrable domain,
  not the email address. A reply from any sibling address at a company counts as
  that company replying. Cadence, stage, and "whose turn is it" are all computed
  at the company level (`core/identity.py`, `core/truth.py`).

- **External truth beats local caches.** What was actually sent is whatever is in
  the provider's Sent box, full stop. Local records are a partial mirror; when
  they disagree with the provider, the provider wins. A dedicated parity engine
  continuously proves the local corpus still mirrors the provider, instead of
  assuming it (`core/parity.py`).

- **Adversarial certification.** The board the operator sees is not trusted just
  because a function produced it. A separate certifier re-derives and challenges
  it, and an auditor cross-checks planes for contradictions and fails loudly
  rather than silently degrading (`core/certify.py`, `core/auditor.py`).

- **Operator-authority model.** Authority is a revocable grant with hard guards
  that never move. Console-fired runs are innately approved (the operator clicked
  it); an agent's concern is one advisory line, not a refusal. The send gate is
  the one exception that is never delegated.

- **Cross-model memory contract.** The LLM shell is provider-agnostic. Every
  model reaches the same skills, commands, and a shared memory store through one
  dispatch point (`llm-shell/bin/llm` + `backend.conf`). Swapping the model is a
  one-line change; the skills, commands, and memory are plain files any harness
  can read. This is what lets different models coordinate on the same work.

- **Wipe-guard backups.** Off-server durability runs on a schedule: local
  snapshots plus a push to a private mirror, with a value-based secret scan that
  aborts the push if anything credential-shaped reaches the staging tree, and
  exclude rules that keep secrets out of the mirror by construction
  (`ops/velab_vault_push.sh`, `ops/velab_backup.sh`).

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
Test fixtures were rebuilt as fully synthetic data. See `docs/VAULT-LAYOUT.md`
for the data model and the individual documents' sanitization notes.

## License

MIT. See [`LICENSE`](LICENSE).
