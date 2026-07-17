---
name: leadgen
description: >
  Velab lead-sourcing command. Runs the full sourcing funnel — discover → scrape →
  verify → land verified leads in the Obsidian vault — for a given (category, country),
  staged with operator checkpoints. Use when the operator types /leadgen, or asks to
  "source/scrape/find leads", "run a lead pass", "find distributors in <country>", or
  "get me N leads for <category>". Read-only on the live Velab pipeline; never sends email.
---

# /leadgen — staged lead sourcing

`/leadgen <category> <country> [count]`  → e.g. `/leadgen lab-distributor Peru 20`

You (Claude) are the **director**; Python does the laboring. You NEVER load raw HTML into
context — the tools fetch, extract, and verify; you generate queries, read short snippets to
enrich, and present checkpoints. One command, three gated stages. Manual only — no automation.

All tools live in `~/.claude/skills/leadgen/tools/` (a self-contained, fixed copy of the
proven pipeline). They write leads into the shared Obsidian vault at
`$VAULT/leads/`. Interpreters: Scrapling/discovery/orchestrator use
`/opt/scrapling-venv/bin/python3`; verify/process use `/usr/bin/python3`.

---

## Hard guardrails (read first — these outrank "get the count")

- **ICP = small/mid LATAM lab, scientific & chemical equipment distributors/importers**
  (microscopes, balances, centrifuges, reagents, diagnostics). NEVER industrial machinery
  (Hilti/Atlas Copco/Caterpillar/construction/power-tools) — drop off-ICP candidates.
- **Role inboxes ARE leads.** `ventas@ comercial@ compras@ gerencia@ info@ contacto@
  coordinacion@ distribuidores@` at a real distributor — that inbox *is* the buyer. Keep them.
  Do NOT chase named executives on LinkedIn (banned).
- **A name & phone are PRIORITIES, not requirements.** Extract when the page shows them;
  leave empty otherwise. **Never fabricate a name** — a made-up name reaches a real human.
- **Never scrape Mexico** (parent-company territory), our own company domain, login-walled pages, or
  social media. **Honor the DNC list** (the verify step rejects DNC domains automatically).
- **No padding, ever.** If clean net-new leads are below the requested count, report the
  real number and the blocker. A truthful "7 verified" beats a padded "20."
- **You only source.** Never draft or send outreach — that's a separate system. This command
  ends at verified leads in the vault.
- **Only the sanctioned tools below.** No ad-hoc `curl`/`web_fetch` to search engines, no
  hand-rolled scrapers, no pulling contacts the orchestrator didn't return. If a tool breaks,
  STOP and report the exact error — a reported blocker is a successful turn.

---

## Step 0 — Resolve the target

1. Map the operator's words to an ICP category key. `lab-distributor` / "distributors" →
   `lab-equipment-distributor`. List valid keys with:
   `/opt/scrapling-venv/bin/python3 ~/.claude/skills/leadgen/tools/source_discovery.py --list-categories`
   Cross-check `$VAULT/reference/ICP.md` for the canonical category + ICP notes.
2. If no country given and the operator said "distributors", default to the proven LATAM set
   (Colombia, Ecuador, Peru, Argentina, Chile) and ask which, or take the operator's pick.
3. Default `count` = 20 if unspecified.
4. Set a batch slug: `<YYYY-MM-DD>-<category>-<country>` (lowercase, hyphenated).

---

## Stage 1 · DISCOVER  →  checkpoint

Generate fresh candidate source URLs and filter out everything already scraped.

```bash
/opt/scrapling-venv/bin/python3 ~/.claude/skills/leadgen/tools/source_discovery.py \
    --category <category-key> --country <Country> \
    --max <count * 2> --max-queries 6
```

- It runs multilingual queries (local language first), filters against the shared source
  registry (nothing already scraped reappears), and prints ranked candidates as JSON
  (url + title + snippet).
- If you can strengthen coverage, you MAY add your own local-language / geo-anchored query
  ideas, but only as input to a re-run — never hand-roll a search. If discovery returns
  zero candidates or errors, **STOP and report** the exact error (do not substitute a search).

**Checkpoint — present to the operator** a compact table: `# | domain | title | why-on-ICP`.
Flag anything that looks off-ICP (industrial, wrong country, marketplace/aggregator). Ask the
operator to **approve / trim / add**. Write the approved URLs to `/tmp/<slug>-urls.txt`
(one per line). Do not proceed until approved.

---

## Stage 1.5 · QUALIFY buying power (scale/footprint)  →  checkpoint

A company's own website **cannot** tell you if it's a real buyer — every distributor, tiny or
huge, calls itself "líder a nivel nacional," lists brands, and shows two cities. Judging by how
polished a site looks would even reject Velab. So qualify on **external, hard size indices**,
never site polish and never named decision-makers (operator 2026-06-09):

```bash
/opt/scrapling-venv/bin/python3 ~/.claude/skills/leadgen/tools/enrich_size.py \
    --candidates /tmp/<slug>-cand.json --country <Country> --pretty
```

It runs a few targeted searxng queries per company and returns a firmographic evidence card:
**employee band** (LinkedIn company size — the spine), **import/customs records** (they're
importers → real buying volume), **public-tender** activity, and web **reach**.

**This is decision SUPPORT, not an auto-classifier** — free-web firmographics are inconsistent.
So:
- **Auto-drop only the clear-cut smalls**: employee band ≤10, OR zero evidence anywhere
  (`low_web_footprint` true with no employee band / import / tender records).
- **Surface everyone else with their evidence card** at the checkpoint. `low_web_footprint`
  is a FLAG, never proof of small — a real-but-obscure firm must survive to your review (the
  "Velab would fail a polish test" rule). Lean on the operator's market knowledge for the call.
- Only the survivors proceed to Stage 2. No cost ever — searxng only, no paid data.

Write the approved survivors' URLs to `/tmp/<slug>-urls.txt`.

---

## Stage 2 · SCRAPE + ENRICH  →  checkpoint

Extract contacts from the approved URLs (3-tier: Scrapling → Crawl4AI; Camoufox stays off
until it can really render). NO `--verify` here — raw scrape only.

```bash
/opt/scrapling-venv/bin/python3 ~/.claude/skills/leadgen/tools/scrape_orchestrator.py \
    --urls-file /tmp/<slug>-urls.txt \
    --batch-name "<slug>" \
    --category "<category-key>" --country "<Country>" \
    --target-description "<one-line target>" \
    --max-subpaths 4
```

This writes a raw batch to `$VAULT/leads/raw/batch-<date>-<slug>.json`. Each lead
carries `extracted_via` (which tier found it), `found_on_url`, and a `_raw_snippet`.

**Enrich (you read the snippets — this is your only per-lead reasoning):** open the raw batch
and for each lead read `_raw_snippet` + `notes` and fill:
- `contact_name` — the person's name as written near the email; empty if none. Do NOT turn an
  email local-part into a name (`maximiliano@…` → empty, not "Maximiliano"). Never invent one.
- `title` — exact title as written; keep `"Role inbox"` for `ventas@`/`info@`/etc.
- `phone` — closest phone with country code; strip fax; empty if none.
Strip any HTML attribute garbage. **Empty-if-unsure beats invented data.** Save the file.

**Checkpoint — present to the operator** the raw haul: per-URL email counts, the tier used,
zero-yield URLs, total unique emails, role-vs-named split. Ask to **approve before verify**
(or drop junk URLs/emails). Do not proceed until approved.

---

## Stage 3 · ICP-RELEVANCE GATE (run BEFORE verify)

Read what each scraped company actually DOES and drop off-ICP **before** spending Reacher
calls (Reacher proves deliverability, NOT ICP fit). Removes law/logistics/EHS/retail/
industrial/marketing/manufacturer-HQ; keeps distributor/adjacent/uncertain; tags every lead
with `icp_verdict`/`icp_reason`. Off-ICP is sidecar'd to `vault/leads/off-icp/`, never deleted.

```bash
/opt/scrapling-venv/bin/python3 ~/.claude/skills/leadgen/tools/icp_classify.py \
    $VAULT/leads/raw/batch-<date>-<slug>.json --country "<Country>" [--llm]
```
Confirm a real slip with `prepare_candidates.py --learn <domain>` so it auto-drops next pass.
Tune `tools/data/icp_lexicon.json` as new markets surface new noise.

## Stage 4 · VERIFY + LAND

Verify, gate, dedupe, and write the verified set. The processor runs a **Reacher liveness
preflight first** and aborts loudly if Reacher is down (so leads are never silently dumped to
deferred) — if it prints `reacher_preflight_failed`, STOP and tell the operator Reacher needs
freeing/restarting; do not work around it.

```bash
/usr/bin/python3 ~/.claude/skills/leadgen/tools/process_leads_batch.py \
    $VAULT/leads/raw/batch-<date>-<slug>.json --pretty
```

**Verification bar (already enforced by the tool):**
- **Verified** = Reacher hard-valid (`safe`) **OR** a buyer **role inbox** at a real
  institution whose mail server is live (catch-all/greylist rescue is scoped to role inboxes).
- **Rejected** = placeholder/example, disposable, dead domain, **DNC-listed**, or a guessed
  *personal* address on a catch-all server we can't confirm.
- Inconclusive/greylisted → `raw/` (review) + `deferred/` for a later re-probe; not "verified".

Outputs land in the vault: `leads/verified/`, `leads/rejected/`, dedupe audit in `leads/audit/`,
registry updated. Then build the Obsidian leadbook for the run:

```bash
/usr/bin/python3 ~/.claude/skills/leadgen/tools/make_leadbook.py <verified-file-path>
```

---

## Final report (every run, in chat)

- **Target:** category · country · requested count
- **Funnel:** candidates discovered → approved URLs → URLs scraped → emails extracted
  (by tier) → verified / rejected / deferred
- **Verified leads:** table of `Institution — Person/Role — Email — Phone — verification_status`
- **Catch-all %** (operator escalates if >50%) and **deferred count**
- **Honest next step:** if the (category, country) is showing exhaustion (few novel
  candidates), say so — next run should discover a new geo/category or grow branches.
- **Files written** (verified JSON + leadbook paths).

Truthfulness is mandatory: report the real verified count, name zero-yield sources plainly,
and never imply verified quality that wasn't proven.
