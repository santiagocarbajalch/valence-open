# DESIGN-LINEAGE — one paragraph per era (written 2026-07-12)

Maintenance rule: when a design era ships or dies, append one paragraph here —
same cadence and hand as CONSOLE-DOCTRINE.md's Amendments log. Superseded full
specs live verbatim in `docs-archive/`; **COCKPIT-V4.md stays at repo root,
UNTOUCHED and un-renumbered — its §0.4/§3.1/§6/§6.5/§11.1/§11.4/§11.5 are cited
by name from 6 live source files and both `verify:cockpit` scripts.**

1. **Pre-rebuild console** (≤2026-06): undocumented; critiqued retroactively in
   `docs-archive/DESIGN.md`.
2. **Design rebuild** (2026-07-01/02, commit `2734d8b`, `docs-archive/DESIGN.md`):
   introduced `src/components/kit/` token system — still the sole color/typography
   access layer today (27 importers). The doc's critique content is history; the
   token architecture it specified is live.
3. **Cockpit v3 "The Full Day"** (2026-07-02, `docs-archive/COCKPIT-V3.md`):
   gap-analysis plan. Superseded by v4, BUT §2.2 (product-shelf/SKU-ficha lookup)
   and §2.6 (day-log) are STILL-UNBUILT backlog whose only spec lives there.
4. **Cockpit v3.1 cadence sections** (2026-07-02,
   `docs-archive/COCKPIT-V3.1-CADENCE-SECTIONS.md`): "PLAN ONLY" header;
   substantially built into BoardList/prose/pipeline; edge cases §8, test plan §9,
   copy appendix §13 remain the detail source.
5. **Cockpit v4 blueprint** (2026-07-04, `COCKPIT-V4.md` at root, commit
   `4f92a0a`): merges v3+v3.1; LIVE spec-of-record — see warning above.
6. **V5 / V5.1 operator redesign** (2026-07-10): no doc — lives in code comments
   and `tests/smoke.spec.ts` header. 3-list rail, Edit+Attach+Send card, one
   Valence box, color triage.
7. **R1–R10 restyle + kills** (2026-07-02→04): Workspace/Team/Orbs removed
   cleanly (smoke test line ~313 asserts the kill).
8. **BENCH GLASS v3 theme** (2026-07-12, commit `dc0cf49`, tag `pre-bench-glass`
   to recover prior): operator's borosilicate theme; same-day superseded.
9. **FRONT OFFICE v2** (2026-07-12, tags `pre-front-office`/`front-office-v2-live`,
   commit `2586bef`): CURRENT live shell — navy workflow sidebar, FRONT OFFICE
   tokens, Hanken Grotesk + Red Hat Mono.
10. **Vault galaxy graph** (2026-07-12, tags `pre-galaxy-graph`/`galaxy-graph-live`):
    volumetric star-tree, Apple-Maps globe gestures (flight camera reverted same day).
11. **Pipeline tab** (2026-07-12, tags `pre-pipeline-tab`/`pipeline-tab-live`):
    7 engine-partition columns beside Today. CURRENT.

Rejected without shipping: **DAYBOOK v1** (2026-07-12) — record lives in
llm-shell memory (`project_console_redesign_drafts.md`), not this repo.
