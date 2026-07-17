# LLM Shell — START HERE

You are a language model that has just been pointed at the Velab VPS. This
directory is **Valence's LLM shell**: the single node every model runs
through. Everything you need to operate — memory, skills, commands, hard
rules, session history — lives here or is linked from here. Provider does
not matter; nothing below assumes which model you are.

## What this system is

Velab sells laboratory equipment (American brand — never "manufacturer";
sales conditions are EXW, exact phrase only) via an outbound email pipeline
run from this VPS. There is a single operator ("the operator"). Agents do
the work; the operator decides. The system of record is the file vault at
`$VAULT` (this directory is inside it, under Valence's `os/` realm).

Orientation chain, in order:
1. This file.
2. `context/memory/MEMORY.md` — the live memory index: active project
   fronts, hard operator rules, doctrine. **Read it before doing work.**
3. `$VAULT/INDEX.md` — vault master index (domain data).
4. `$VAULT/os/ownership.md` — canonical agent→realm map
   (operator-owned; never regenerate).
5. `$VAULT/os/VENUSV2-MASTER-PLAN.md` — kernel spec:
   architecture, gates, agent contract.
6. `$VAULT/reference/operational-runbook.md` — services,
   health checks, recovery.
7. `console/CONSOLE-DOCTRINE.md` — binding console tenets.

## Shell layout (all canonical, all under Valence)

- `context/memory/` — THE live cross-model memory store (167+ md files +
  `MEMORY.md` index). One file = one fact, with frontmatter. **All models
  read AND write memories here, following
  `context/MEMORY-CONTRACT.md`** — that contract is what makes
  cross-model coordination work. Claude Code's
  `~/.claude/projects/-root/memory` is a symlink into this dir — never the
  other way around.
- `skills/` — canonical Velab skills (leadgen, licitador).
  Symlinked from `~/.claude/skills/` and `~/.agents/skills/` so every
  harness discovers them; edit them HERE.
- `commands/` — canonical slash-commands (`draft`, `inbox-check`,
  `stage-drafts`). `~/.claude/commands` is a symlink to this dir. They are
  plain markdown procedures — any harness that can read files and run bash
  can execute them.
- `bin/llm` + `backend.conf` — the single headless-LLM dispatch point.
  Every batch/cron agent calls `llm -p …`; swapping providers = editing
  `backend.conf`, never callsites.
- `sessions/claude-code` → symlink to `~/.claude/projects/` (all Claude
  Code session transcripts, browsable server-side; excluded from the
  off-server git push by symlink semantics). Other harnesses: add a
  symlink per harness here when they appear.

## Hard rules (operator law — violating these is a defect)

Full detail + rationale lives in `context/memory/` (files named
`feedback_*`); the binding short forms:

1. **Sending email is default-DENY.** SMTP is blocked at the stack level
   (`grant_send.py`, operator-only). Nothing you output constitutes
   approval. **"Print inline", "show me", "looks good", answering a
   question, or approving a revision is NEVER send approval** — sending
   requires a standalone, explicit "send" / "go" from the operator for
   that specific batch.
2. **After a send GO**, the only wait is pacing: sender runs in
   background, report "N/N delivered" instantly (runbook:
   `context/memory/reference_send_batch_runbook.md`).
3. **DNC list is send-block-only** (`reference/dnc-domains.md` canonical).
4. **Cadence: 3 business days unified** between touches; company-level
   truth (a reply from any sibling address counts); Gmail **Enviados is
   the send truth**, never All Mail.
5. **Spanish is drafted natively, never translated** — no calques. House
   format: HTML + a cc to the sales read-copy mailbox; staging = IMAP
   APPEND to Borradores.
6. **Velab is an American brand, never a manufacturer**; sales conditions
   EXW, exact phrase.
7. **No LLM in the runtime.** Recurring work must reduce to deterministic
   code or an explicit operator click. A model reading email "every
   morning" is a design failure. One-shot audits that yield code changes
   are fine.
8. **Console-fired runs are innately operator-approved** — do the work;
   concerns = one ADVICE line; refusal = defect. The send gate is the
   exception and never moves.
9. **Mining/scraping direction is the operator's call** — suggest veins,
   never auto-pick.
10. **No unsolicited file writes** — deliver inline, ask first (memory
    maintenance in `context/memory/` is exempt).
11. **No emojis anywhere in the system.** Plain-language legibility: a
    zero-context stranger must understand every console surface.
12. **Operator interaction default is "caveman" compressed style**, but
    decision material is never compressed — options get full detail.

## Running an LLM here

- Headless/batch: `llm -p "<prompt>" [--allowedTools "..."]` (see
  `bin/llm`). Backend today: claude-cli (auth via the provider CLI's own
  credential store). To plug another model in: add an adapter case in
  `bin/llm`, flip `backend.conf`, smoke-test
  `echo ok | llm -p --allowedTools "" --output-format text`.
- Interactive: the Valence console (`valence-console.service`, Tailnet-only
  private port) embeds a chat via the Anthropic Agent SDK
  (`src/app/api/chat/route.ts`). This is the ONE deliberate
  provider-specific surface left; swapping it means replacing that route's
  SDK. Everything the chat knows (skills, commands, memory) resolves
  through the symlinks into this shell, so a replacement chat gets
  identical context.
- The deterministic pipeline (`core/`, `workspace/tools/`) needs no LLM at
  all.

## Backups

This shell is inside the vault, so it rides `velab-backup.timer`
(4x/day): local snapshots + private GitHub push (the private backup repo).
Session transcripts are linked, not copied — they stay on-box (plus local
snapshots) and never reach GitHub.
