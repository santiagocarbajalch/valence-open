#!/usr/bin/env python3
"""integrity.py — the ONE living guard (blueprint §7). Daily + on demand.

The audit found every drift-guard dead (state_parity, custodio, vault_index,
reputation compute, new-mail poll). This replaces them with one unit that actually
runs and one report the console/board can surface:
  1. certify --full        adversarial board certification (own IMAP pull)
  2. view freshness        board.json age, companies/INDEX age vs board
  3. broken symlinks       workspace/tools dangling links (latent-crash class)
  4. bounce / reputation   DSN rate over 7d from the corpus; writes the send-pause
                           flag smtp.js already honors (kill-switch resurrected)
  5. phantom reconcile     phantom_audit.py (read-only EXAMINE) diffs live Gmail
                           Message-IDs vs the append-only corpus; an ACTIVE phantom
                           (deleted mail truth.py would still count) fails the run
Writes vault/state/integrity.json + prints a human summary. Exit 1 on any FAIL.
"""
import json, os, re, subprocess, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import identity as ident
import truth

VAULT = Path("/opt/velab/vault")
OUT = VAULT / "state/integrity.json"
PAUSE = VAULT / "pipeline/reputation/send-pause.json"
BOUNCE_PAUSE_PCT = 5.0

def main():
    fails, warns, info = [], [], {}

    # 1. adversarial certification — re-derive FIRST or the age gate always fails
    # (pre-2026-07-07 this certified a ~10h-old board, so the nightly run was
    # permanently red and its real findings drowned in the age noise)
    rd = subprocess.run([sys.executable, str(Path(__file__).parent / "truth.py")],
                        capture_output=True, text=True, timeout=600)
    if rd.returncode != 0:
        fails.append("truth.py re-derive failed before cert: " + (rd.stderr or "")[-200:])
    r = subprocess.run([sys.executable, str(Path(__file__).parent / "certify.py"), "--full", "--json"],
                       capture_output=True, text=True, timeout=900)
    try:
        cert = json.loads(r.stdout)
    except Exception:
        cert = {"certified": False, "fails": ["certify.py produced no JSON"]}
    info["cert"] = {"certified": cert.get("certified"), "mode": cert.get("mode"),
                    "fails": cert.get("fails"), "warns": cert.get("warns")}
    if not cert.get("certified"):
        fails.append("board NOT certified (full mode): " + "; ".join(cert.get("fails") or []))

    # 2. view freshness
    now = datetime.now(timezone.utc)
    def age_min(p):
        try:
            return (now - datetime.fromtimestamp(p.stat().st_mtime, timezone.utc)).total_seconds() / 60
        except Exception:
            return None
    b_age = age_min(VAULT / "state/board.json")
    i_age = age_min(VAULT / "companies/INDEX.md")
    info["board_age_min"], info["index_age_min"] = b_age, i_age
    if b_age is None or b_age > 24 * 60:
        fails.append(f"board.json is {b_age and int(b_age)}m old — derive chain is down")
    if i_age is not None and b_age is not None and i_age - b_age > 60:
        warns.append("companies/INDEX.md lags the board by >1h — page regeneration broken?")

    # 3. broken symlinks (latent crashes)
    broken = []
    for p in Path("/opt/velab/workspace/tools").iterdir():
        if p.is_symlink() and not p.exists():
            broken.append(p.name)
    info["broken_symlinks"] = broken
    if broken:
        warns.append(f"{len(broken)} broken symlink(s) in workspace/tools: {', '.join(broken[:6])}")

    # 4. bounce / reputation (kill-switch resurrected)
    allmail, sent, _ = truth.corpus_store.load_shards()
    week_ago = (now - timedelta(days=7)).date().isoformat()
    dsns = sum(1 for m in allmail
               if (m.get("date") or "")[:10] >= week_ago
               and re.search(r"mailer-daemon|postmaster", (m.get("from") or ""), re.I))
    sends = sum(1 for m in sent if (m.get("date") or "")[:10] >= week_ago)
    rate = (100.0 * dsns / sends) if sends else 0.0
    info["bounces_7d"], info["sends_7d"], info["bounce_rate_pct"] = dsns, sends, round(rate, 2)
    PAUSE.parent.mkdir(parents=True, exist_ok=True)
    paused = rate >= BOUNCE_PAUSE_PCT and sends >= 20
    PAUSE.write_text(json.dumps({"paused": paused, "reason": f"bounce rate {rate:.1f}% over 7d "
                                 f"({dsns}/{sends})" if paused else "",
                                 "computed_at": now.isoformat(), "by": "integrity.py"}, indent=1))
    if paused:
        fails.append(f"SEND PAUSED — bounce rate {rate:.1f}% (≥{BOUNCE_PAUSE_PCT}%)")

    # 5. phantom reconcile — the corpus is append-only, so mail deleted in Gmail persists
    # as phantoms. Inert = self-authored draft twins truth.py already discards (baseline
    # 101, 2026-07-09 audit); an ACTIVE phantom (deleted inbound / deleted sent) would
    # corrupt the board silently, so it fails the run. DEGRADED (IMAP flake) only warns.
    p = subprocess.run([sys.executable, "/opt/velab/workspace/tools/phantom_audit.py",
                        "--quiet"], capture_output=True, text=True, timeout=600)
    try:
        ph = json.loads((VAULT / "state/phantom_audit.json").read_text())
        if ph.get("ran_at", "")[:10] != now.date().isoformat():
            raise ValueError("stale report")
    except Exception:
        ph = {"degraded": True, "inert": [], "active": []}
        warns.append("phantom_audit.py produced no fresh report: " + (p.stderr or p.stdout or "")[-200:])
    n_inert, n_active = len(ph.get("inert") or []), len(ph.get("active") or [])
    info["phantoms"] = {"degraded": ph.get("degraded"), "inert": n_inert, "active": n_active}
    ph_str = "degraded" if ph.get("degraded") else f"{n_inert} inert / {n_active} active"
    if ph.get("degraded"):
        warns.append("phantom audit DEGRADED — IMAP unreachable; corpus-vs-live diff skipped this run")
    elif n_active:
        fails.append(f"{n_active} ACTIVE phantom(s) in the corpus — deleted Gmail mail truth.py "
                     f"still counts; see vault/state/phantom_audit.json")

    report = {"checked_at": now.isoformat(), "ok": not fails, "fails": fails, "warns": warns, **info}
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(("✅ INTEGRITY OK" if not fails else "❌ INTEGRITY FAIL") +
          f" — cert:{'✓' if cert.get('certified') else '✗'} board:{b_age and int(b_age)}m "
          f"bounce:{rate:.1f}% ({dsns}/{sends}) symlinks-broken:{len(broken)} "
          f"phantoms: {ph_str}")
    for w in warns:
        print(f"  ⚠️  {w}")
    for f in fails:
        print(f"  ❌ {f}")
    return 0 if not fails else 1

if __name__ == "__main__":
    sys.exit(main())
