#!/usr/bin/env python3
"""mine_outcomes.py — CLOSE THE LOOP: join sales outcomes back to lead sources.

Joins the company-truth board (vault/state/board.json — who we contacted, who
replied, who booked meetings, who closed) against the verified lead batches
(vault/leads/verified/*.json — which dig produced each company).

Output = per-geo / per-category / per-batch scoreboard: contacted, replied,
meetings, closes. THIS IS A SUGGESTION SURFACE ONLY — dig direction is the
operator's call (business context lives outside the system).

Usage:
  /usr/bin/python3 mine_outcomes.py            # human table
  /usr/bin/python3 mine_outcomes.py --json     # machine JSON to stdout
  /usr/bin/python3 mine_outcomes.py --write    # also persist vault/leads/system/mine-outcomes.json

Read-only on the pipeline; writes only the sidecar with --write.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lead_guards import registrable_root

VAULT = Path.home() / "velab" / "vault"
BOARD = VAULT / "state" / "board.json"
VERIFIED_DIR = VAULT / "leads" / "verified"
OUT_SIDECAR = VAULT / "leads" / "system" / "mine-outcomes.json"

# verified filenames: 2026-06-24__lab-distributor__thailand[__suffix].json
FNAME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})__([^_]+(?:-[^_]+)*)__(.+?)\.json$")

SKIP_SUFFIXES = (".bak", ".full", ".alloffICP")


def load_verified_origins():
    """domain -> earliest {batch, date, category, geo}; only manifest-ACTIVE files."""
    from warehouse_manifest import active_files, load as load_manifest
    origins = {}
    active = active_files()
    skipped = [n for n, v in load_manifest()["files"].items() if v["status"] != "active"]
    for f in active:
        m = FNAME_RE.match(f.name)
        date, cat, geo = (m.group(1), m.group(2), m.group(3)) if m else ("?", "?", f.stem)
        geo = re.sub(r"__.*$", "", geo)  # strip __fresh/__02 style suffixes
        try:
            data = json.loads(f.read_text())
        except Exception:
            skipped.append(f.name + " (unreadable)")
            continue
        leads = data if isinstance(data, list) else data.get("leads", data.get("results", []))
        if not isinstance(leads, list):
            continue
        for lead in leads:
            email = (lead.get("email") or "").lower()
            if "@" not in email:
                continue
            dom = registrable_root(email.split("@")[-1])
            if not dom:
                continue
            rec = {"batch": f.name, "date": date, "category": cat, "geo": geo}
            # earliest batch wins as origin (files sorted by name = by date)
            origins.setdefault(dom, rec)
    return origins, skipped


def load_board():
    b = json.loads(BOARD.read_text())
    rows = {}
    for c in b.get("companies", []):
        dom = registrable_root(c.get("key") or "")
        if not dom:
            continue
        rows[dom] = {
            "replied": bool(c.get("last_in_date")),
            "meeting": (c.get("meeting_state") in ("scheduled", "held")),
            "state": c.get("state"),
            "close_reason": c.get("close_reason"),
            "touches": c.get("touches"),
        }
    return rows


def build():
    origins, skipped = load_verified_origins()
    board = load_board()

    per = {"geo": defaultdict(lambda: defaultdict(int)),
           "category": defaultdict(lambda: defaultdict(int)),
           "batch": defaultdict(lambda: defaultdict(int))}
    unmatched_contacted = []

    for dom, o in origins.items():
        for axis, key in (("geo", o["geo"]), ("category", o["category"]), ("batch", o["batch"])):
            per[axis][key]["verified"] += 1

    for dom, row in board.items():
        o = origins.get(dom)
        if not o:
            unmatched_contacted.append(dom)
            continue
        for axis, key in (("geo", o["geo"]), ("category", o["category"]), ("batch", o["batch"])):
            agg = per[axis][key]
            agg["contacted"] += 1
            if row["replied"]:
                agg["replied"] += 1
            if row["meeting"]:
                agg["meetings"] += 1
            if row["close_reason"]:
                agg["closed"] += 1

    def finish(d):
        out = {}
        for k, v in d.items():
            v = dict(v)
            c = v.get("contacted", 0)
            v["reply_rate"] = round(v.get("replied", 0) / c, 3) if c else None
            v["uncontacted"] = v.get("verified", 0) - c
            out[k] = v
        return out

    return {
        "note": "SUGGESTION SURFACE ONLY — dig direction is the operator's call.",
        "geo": finish(per["geo"]),
        "category": finish(per["category"]),
        "batch": finish(per["batch"]),
        "contacted_not_from_mine": sorted(unmatched_contacted),
        "warehouse_files_skipped": skipped,
    }


def table(result):
    lines = []
    for axis in ("geo", "category"):
        lines.append(f"\n== BY {axis.upper()} ==")
        lines.append(f"{'':24} {'verif':>5} {'contact':>7} {'replied':>7} {'meet':>4} {'reply%':>6} {'fresh':>5}")
        rows = sorted(result[axis].items(),
                      key=lambda kv: (-(kv[1].get("replied", 0)), -(kv[1].get("contacted", 0))))
        for k, v in rows:
            rr = v.get("reply_rate")
            lines.append(f"{k[:24]:24} {v.get('verified',0):>5} {v.get('contacted',0):>7} "
                         f"{v.get('replied',0):>7} {v.get('meetings',0):>4} "
                         f"{('%.0f%%' % (rr*100)) if rr is not None else '-':>6} {v.get('uncontacted',0):>5}")
    n_un = len(result["contacted_not_from_mine"])
    lines.append(f"\ncontacted companies with no mined origin (pre-mine era / manual): {n_un}")
    if result["warehouse_files_skipped"]:
        lines.append(f"warehouse files skipped as junk/parked: {len(result['warehouse_files_skipped'])}")
    lines.append("\nNOTE: suggestion only — where we dig next is the operator's call.")
    return "\n".join(lines)


if __name__ == "__main__":
    res = build()
    if "--json" in sys.argv:
        print(json.dumps(res, indent=2))
    else:
        print(table(res))
    if "--write" in sys.argv:
        OUT_SIDECAR.parent.mkdir(parents=True, exist_ok=True)
        OUT_SIDECAR.write_text(json.dumps(res, indent=2))
        print(f"\nwrote {OUT_SIDECAR}", file=sys.stderr)
