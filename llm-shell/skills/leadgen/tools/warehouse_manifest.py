#!/usr/bin/env python3
"""warehouse_manifest.py — explicit per-file status for the verified-leads warehouse.

Ends the "which batches are poison lives in someone's memory" problem. Every file in
vault/leads/verified/ gets a status in vault/leads/system/warehouse-manifest.json:

  active  — real inventory, safe to rank/pull
  parked  — kept on disk but excluded (bad-ICP batch awaiting re-verification)
  junk    — .bak / trim-backup artifacts, never inventory

Rules on sync: *.bak* / *.full-* / *.alloffICP* -> junk automatically. New files
default to active. Existing statuses are never overwritten by sync. Parking a batch
is an explicit command (operator decision or operator-confirmed slip).

Usage:
  /usr/bin/python3 warehouse_manifest.py sync            # scan + add new files
  /usr/bin/python3 warehouse_manifest.py list [status]
  /usr/bin/python3 warehouse_manifest.py set <filename> <active|parked|junk> [--reason "..."]
"""
import json
import sys
from datetime import date
from pathlib import Path

VAULT = Path.home() / "velab" / "vault"
VERIFIED_DIR = VAULT / "leads" / "verified"
MANIFEST = VAULT / "leads" / "system" / "warehouse-manifest.json"

JUNK_MARKERS = (".bak", ".full-", ".alloffICP")

# operator-confirmed parked batches (seed; manifest is source of truth after first sync)
SEED_PARKED = {
    "2026-06-23__lab-distributor__guatemala.json":
        "CIG SSO roster — 9 email-verified, 0 valid ICP (law/EHS/GS1/chamber); parked per operator 2026-06-24",
}


def load():
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text())
    return {"files": {}}


def save(m):
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(m, indent=2, sort_keys=True))


def sync():
    m = load()
    added = []
    for f in sorted(VERIFIED_DIR.iterdir()):
        if not f.is_file():
            continue
        name = f.name
        if name in m["files"]:
            continue
        if any(j in name for j in JUNK_MARKERS):
            status, reason = "junk", "backup/trim artifact (auto)"
        elif name in SEED_PARKED:
            status, reason = "parked", SEED_PARKED[name]
        elif not name.endswith(".json"):
            status, reason = "junk", "not a batch json (auto)"
        else:
            status, reason = "active", ""
        m["files"][name] = {"status": status, "reason": reason, "since": str(date.today())}
        added.append((name, status))
    save(m)
    return m, added


def active_files():
    """The one call other tools use: absolute paths of ACTIVE batch files only."""
    m, _ = sync()
    return [VERIFIED_DIR / n for n, v in sorted(m["files"].items())
            if v["status"] == "active" and (VERIFIED_DIR / n).exists()]


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else "list"
    if cmd == "sync":
        m, added = sync()
        for n, s in added:
            print(f"+ {s:6} {n}")
        counts = {}
        for v in m["files"].values():
            counts[v["status"]] = counts.get(v["status"], 0) + 1
        print(f"manifest: {counts}")
    elif cmd == "set":
        name, status = args[1], args[2]
        assert status in ("active", "parked", "junk"), "status must be active|parked|junk"
        reason = args[args.index("--reason") + 1] if "--reason" in args else ""
        m = load()
        if name not in m["files"]:
            sys.exit(f"unknown file: {name} (run sync first)")
        m["files"][name].update({"status": status, "reason": reason, "since": str(date.today())})
        save(m)
        print(f"{name} -> {status}")
    else:
        want = args[1] if len(args) > 1 else None
        m, _ = sync()
        for n, v in sorted(m["files"].items()):
            if want and v["status"] != want:
                continue
            print(f"{v['status']:6}  {n}" + (f"  — {v['reason']}" if v["reason"] else ""))
