#!/usr/bin/env python3
"""
auditor.py — the data-integrity guard (VENUSV2-MASTER-PLAN §4.7 "Auditor",
designed 2026-06 and never built; built 2026-07-14 after the acme-labs.example.com loss).

Distinct from:
  - the Archivist   (reads the inbox, writes conversation truth),
  - certify.py      (adversarial completeness: is every thread ON the board or
                     explained by a registry — a MEMBERSHIP check),
  - integrity.py    (job/corpus health: phantoms, bounce kill-switch).

The Auditor answers a different question: **is the STORED, RENDERED data
correct and consistent across planes** — specifically, can a company the
operator needs to see ever become invisible on every surface? That is the exact
class that let a frozen lead's hot reply (acme-labs.example.com) vanish. The Auditor
re-derives truth from the corpus plane and cross-checks it against the persisted
board plane and the rendered view plane, and it FAILS LOUD: alerts land in
vault/state/audit.json, get surfaced at the top of /inbox-check and in the
console, and a critical alert exits non-zero.

Run: `python3 auditor.py` (after truth.py + certify.py). Read-only except audit.json.
"""
import json, sys, os
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import truth, render_board

VAULT = truth.VAULT
BOARD = truth.BOARD
AUDIT = truth.STATE / "audit.json"
INTEGRITY = truth.STATE / "integrity.json"
PARITY = truth.STATE / "parity.json"
TRIAGE = truth.STATE / "deletion-triage.json"
OWE_FAMILY = {"owe", "owe-review"}
FRESH_BOARD_MAX_MIN = 45
CORPUS_MAX_MIN = 90


def _age_min(iso):
    try:
        return int((datetime.now(timezone.utc) - datetime.fromisoformat(iso)).total_seconds() / 60)
    except Exception:
        return None


def run():
    alerts = []   # {level: critical|warn, code, keys, detail}

    def crit(code, detail, keys=()):
        alerts.append({"level": "critical", "code": code, "detail": detail, "keys": sorted(keys)})

    def warn(code, detail, keys=()):
        alerts.append({"level": "warn", "code": code, "detail": detail, "keys": sorted(keys)})

    # --- planes ------------------------------------------------------------
    try:
        board = json.loads(BOARD.read_text())
    except Exception as e:
        crit("BOARD_UNREADABLE", f"persisted board.json unreadable: {e}")
        return finish(alerts)

    meta = board.get("meta", {})
    # re-derive independently from the corpus plane (local shards; no live IMAP)
    try:
        fresh = truth.derive()
    except Exception as e:
        crit("DERIVE_FAILED", f"independent re-derive threw: {type(e).__name__}: {str(e)[:160]}")
        fresh = None

    # --- A. registry-load health (the fail-open guard) ---------------------
    le = meta.get("load_errors") or []
    if le:
        crit("REGISTRY_LOAD_ERROR",
             "a gating registry was PRESENT but unreadable — suppression may have "
             "silently dropped, un-hiding frozen/DNC/closed leads: " + "; ".join(le[:5]))
    if fresh is not None:
        fle = fresh.get("meta", {}).get("load_errors") or []
        if fle and not le:
            crit("REGISTRY_LOAD_ERROR_FRESH", "registry read failing right now: " + "; ".join(fle[:5]))

    # --- B. PINGED completeness: every suppressed-but-hot lead is in the tray
    tray_keys = {r.get("key") for r in board.get("operator_frozen_pinged") or []}
    if fresh is not None:
        fresh_tray = {r.get("key") for r in fresh.get("operator_frozen_pinged") or []}
        missing = fresh_tray - tray_keys
        if missing:
            crit("PINGED_DRIFT",
                 "the corpus says these suppressed leads wrote back hot, but the persisted "
                 "board's pinged tray does not carry them (stale board — re-derive): "
                 + ", ".join(sorted(missing)), missing)

    # --- C. RENDER visibility: the tray must actually appear in the view ----
    try:
        view = render_board.build_view(board)
        rendered = {r.get("key") for r in view.get("pinged_rows") or []}
        digest_secs = {s["id"]: s for s in view.get("digest", {}).get("sections", [])}
        digest_pinged = {r.get("key") for r in (digest_secs.get("pinged", {}).get("rows") or [])}
        dropped = tray_keys - rendered
        if dropped:
            crit("PINGED_NOT_RENDERED",
                 "pinged leads present in board.json but DROPPED by the full-board renderer "
                 "(invisible on that surface): " + ", ".join(sorted(dropped)), dropped)
        dropped_d = tray_keys - digest_pinged
        if dropped_d:
            crit("PINGED_NOT_IN_DIGEST",
                 "pinged leads missing from the /inbox-check DIGEST (the operator's default "
                 "surface): " + ", ".join(sorted(dropped_d)), dropped_d)
    except Exception as e:
        warn("RENDER_CHECK_FAILED", f"could not build the view to verify visibility: {str(e)[:120]}")

    # --- D. suppressed-but-owed: a suppressed lead holding the ball that the
    #        pinged gate did NOT catch (reply predates the freeze, or a soft
    #        signal). Softer than PINGED — advisory, but must not stay silent
    #        (the equipment-pa.com class: closed with a logged unanswered ask).
    src = (fresh or board).get("suppressed_engaged") or []
    owed_hidden = [c for c in src
                   if c.get("them_last") and c.get("bucket") in OWE_FAMILY and not c.get("pinged")]
    if owed_hidden:
        warn("SUPPRESSED_HOLDS_BALL",
             f"{len(owed_hidden)} suppressed lead(s) where THEY hold the ball (owed reply) but the "
             "pinged gate did not fire — verify the freeze/close is still the right call: "
             + ", ".join(c.get("key") for c in owed_hidden[:8]),
             [c.get("key") for c in owed_hidden])

    # --- E. dead-mailbox consistency: truth.py now parks a cold lead whose every
    #        send target is DNC'd/bounced into the `dead` substate (out of the
    #        ladder). Verify the invariant holds — a row flagged dead must NEVER
    #        also count as due (that would re-fire at a dead address, the beta-diagnostics.example.com
    #        class). A live failure here means the dead-mailbox guard regressed.
    leaks = [c.get("key") for c in (fresh or board).get("companies", [])
             if c.get("dead_mailbox") and c.get("cold_substate") == "due"]
    if leaks:
        crit("DEAD_MAILBOX_STILL_DUE",
             f"{len(leaks)} lead(s) flagged dead-address yet still marked cold-due — the cadence "
             "engine would re-send to a dead mailbox: " + ", ".join(leaks[:8]), leaks)
    n_dead = (fresh or board).get("meta", {}).get("counts", {}).get("cold_dead", 0)
    if n_dead:
        alerts.append({"level": "warn", "code": "DEAD_ADDRESSES_PARKED",
                       "detail": f"{n_dead} cold lead(s) parked as dead (every address bounced/DNC) — "
                                 "consider closing them out so they stop occupying the pipeline",
                       "keys": []})

    # --- F. freshness of the plane under test ------------------------------
    ba = _age_min(meta.get("as_of"))
    if ba is not None and ba > FRESH_BOARD_MAX_MIN:
        warn("BOARD_STALE", f"persisted board is {ba}m old (> {FRESH_BOARD_MAX_MIN}m) — re-derive before trusting it")
    ca = meta.get("corpus_age_min")
    if isinstance(ca, int) and ca > CORPUS_MAX_MIN:
        warn("CORPUS_STALE", f"corpus was {ca}m old at derive time — the archivist pull may be behind")
    if meta.get("degraded"):
        crit("BOARD_DEGRADED", "board was derived from an EMPTY/failed corpus pull — do not trust it")

    # --- G. IMAP PARITY (parity.py) — the independent corpus↔live-Gmail check.
    #        This is the real cross-plane guard (raw IMAP vs raw corpus, no
    #        derive()), so it supersedes the older integrity-phantom read.
    try:
        pj = json.loads(PARITY.read_text())
        page = _age_min(pj.get("ran_at"))
        if page is not None and page > 240:
            warn("PARITY_STALE", f"the IMAP-parity check last ran {page//60}h ago — the guard may have "
                 "crashed or its timer stopped; the mirror is unverified until it runs again")
        if pj.get("degraded"):
            warn("PARITY_DEGRADED", "parity check could not reach Gmail this run — mirror unverified")
        else:
            dele = pj.get("deletions", {}) or {}
            active = dele.get("active", []) or []
            if active:
                hard = [a for a in active if a.get("where") == "hard_deleted"]
                keys = sorted({a.get("company_key") or a.get("from") or "?" for a in active})
                # a real deleted message the append-only corpus still holds. Critical
                # if any looks like a real counterparty; the triage job (below) refines.
                level = crit if hard else warn
                level("PARITY_DELETION",
                      f"{len(active)} message(s) deleted from Gmail the corpus still holds "
                      f"({len(hard)} hard-deleted, {len(active)-len(hard)} in Trash): "
                      + ", ".join(keys[:8]) + " — acknowledge as junk or investigate a lost message",
                      keys)
            gaps = pj.get("coverage_gaps", {}) or {}
            if gaps.get("count"):
                warn("PARITY_COVERAGE_GAP",
                     f"{gaps['count']} message(s) exist in Gmail on days the corpus claims complete "
                     "but were never mirrored — the mirror is under-reporting; re-pull those days")
    except FileNotFoundError:
        # fall back to the older integrity signal until parity.py has run once
        try:
            ig = json.loads(INTEGRITY.read_text())
            if (ig.get("phantoms") or {}).get("active"):
                warn("INTEGRITY_PHANTOMS",
                     f"{ig['phantoms']['active']} active phantom(s) — run parity.py for the deletion-aware check")
        except Exception:
            pass
    except Exception as e:
        warn("PARITY_UNREADABLE", f"parity.json present but unreadable: {str(e)[:120]}")

    # --- H. deletion-triage tray (deletion_triage.py) — LLM-proposed classifications
    #        of real deletions, awaiting operator confirm. Surface the count only.
    try:
        tj = json.loads(TRIAGE.read_text())
        pending = [p for p in (tj.get("proposals") or []) if p.get("status") == "pending"]
        if pending:
            warn("DELETION_TRIAGE_PENDING",
                 f"{len(pending)} deleted message(s) triaged and awaiting your call "
                 "(acknowledge as junk, or rescue a real one) — see deletion-triage.json")
    except Exception:
        pass

    return finish(alerts)


def finish(alerts):
    crits = [a for a in alerts if a["level"] == "critical"]
    warns = [a for a in alerts if a["level"] == "warn"]
    if crits:
        summary = f"AUDIT FAILED — {len(crits)} critical, {len(warns)} warning"
    elif warns:
        summary = f"audit ok — {len(warns)} warning"
    else:
        summary = "audit clean"
    audit = {
        "ok": not crits,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "auditor": "auditor.py v1",
        "summary": summary,
        "critical": len(crits), "warnings": len(warns),
        "alerts": alerts,
    }
    tmp = AUDIT.with_suffix(f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(audit, ensure_ascii=False, indent=1))
    os.replace(tmp, AUDIT)
    return audit


def main():
    audit = run()
    print(audit["summary"])
    for a in audit["alerts"]:
        mark = "❌" if a["level"] == "critical" else "⚠️"
        print(f"  {mark} [{a['code']}] {a['detail']}")
    sys.exit(0 if audit["ok"] else 1)


if __name__ == "__main__":
    main()
