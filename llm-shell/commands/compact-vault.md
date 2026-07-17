# /compact-vault — periodic summarize-don't-delete consolidation pass

Operator-fired only (never scheduled — hard rule 7: no LLM in the runtime).
Goal: reduce the number/volume of files a model must read to reconstruct state,
by archiving superseded clusters and synthesizing ledgers. NOTHING is deleted.

## Standing rules (violating these is a defect)

1. **Archive, never delete.** House convention: move into a sibling
   `_superseded-YYYY-MM-DD/` directory (or `leads/_history/`). Raw bytes stay.
2. **Grep readers before ANY move.** A file is only archivable when
   `grep -rn "<path-fragment>" workspace/tools core valence-console/src
   vault/os/llm-shell` proves zero live readers — or the reader guards for the
   missing path. Lesson on file: intel/verdicts v1 "looked dead" but is
   company_state.py's ONLY verdict source (console workbench primary).
3. **OPEN sections migrate before their file archives.** Any unresolved TODO in
   a candidate file gets hand-carried into the current live front file first.
4. **Regenerators win.** Files written by core/pages.py, core/archivist.py,
   vault_index.py, custodio_check.py, vault_lint.py are views — never hand-edit
   or archive them; fix their generator instead. Check
   `vault/reference/state-contract.md` (writer/reader map) for every candidate.
5. **After moves:** run `python3 workspace/tools/vault_index.py` and
   `python3 workspace/tools/path_assert.py`; both must come back clean.
6. **Every pass appends to the ledger** at
   `vault/audits/consolidation/LEDGER.md`: date, what moved where, proof line.
7. **Send gate, ownership.md, ~/.claude symlinks, os/mirror/, dnc.jsonl,
   state/board.json, COCKPIT-V4.md are untouchable.** Full do-not-touch list in
   `vault/audits/2026-07-12-consolidation-audit/REPORT.md`.

## Procedure

1. Read `vault/audits/consolidation/PENDING.md` — the checklist from the last
   pass. First verify each `pending` item's status on disk (done? still valid?)
   and update it. Never re-derive what the checklist already proves.
2. Read the deterministic reports (they run 4x/day, fresher than any memory):
   `vault/audits/path-assert/latest.md` (doc rot),
   `vault/audits/custodio/REPORT.md`, `vault/audits/format-standardization/reports/latest.md`.
3. Sweep for NEW candidates, in this order of value:
   a. dirs whose entire contents share one old mtime (dead snapshots),
   b. `*.bak*` files and `_V<n>` chains outside a governed lineage policy,
   c. per-item record dirs with no rollup ledger (compare against the working
      patterns: operator-authority-log.md, intel/manifest.json, LEADBOOK.md),
   d. docs describing architecture that grep proves deleted,
   e. memory files: closed fronts still holding full MEMORY.md index lines.
4. For each candidate: reader-grep proof → risk call → add to PENDING.md as a
   table row (path, action, proof, risk, status).
5. Present the PENDING table to the operator. Execute ONLY on explicit GO,
   item-scoped or "go all". Then apply rules 5–6 above.

## Cadence

Operator fires it. Suggested rhythm: after any teardown/redesign, or when
path-assert starts reporting broken refs, or monthly — whichever comes first.
