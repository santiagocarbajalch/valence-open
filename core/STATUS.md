# core/ — build status (written 2026-07-12, consolidation audit; update when a build lands)

Deterministic agent kernel (blueprint 2026-07-02). Backs two live systemd units:
`archivist2.service` (~9 min) and `velab-integrity.service` (daily 06:15). All
other modules here are imported libraries, not directly ExecStart'd.

| Build | What | Status | Commit |
|---|---|---|---|
| B1 | identity.py + truth.py v2 — company-keyed persisted board | DONE | 113adc1 |
| B2 | certify.py v2 — adversarial certifier, bucket parity | DONE | 4655fde |
| B3 | (no discrete commit — content folded into adjacent builds or not built) | ABSENT | — |
| B4 | archivist.py v2 — company bundles, locks, poison-pill, deterministic meetings | DONE | f491774 |
| B5 | codebook.py + pages.py — humanized company pages + INDEX | DONE | 1d3891a |
| B6 | (no discrete commit — content folded into adjacent builds or not built) | ABSENT | — |
| B7 | integrity.py guard + timer, /draft rewire, certify retries | PARTIAL | f1ba9d0 |
| B8 | physical vault reorg | GATED on operator "tree approved" | — |

Post-build era: 756f7b8 (ownership-manifest sweep). This table is a rollup of
`git log --oneline` — regenerate by reading commit messages, they carry "Build N:" prefixes.
