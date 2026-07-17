#!/usr/bin/env python3
"""retro_pass.py — retroactive quality + freshness pass over the verified warehouse.

Operator-approved 2026-07-06 ("go"). Two phases, run separately (different venvs):

  --icp     (run with /opt/scrapling-venv/bin/python3)
            Classify what each company DOES for leads that predate the ICP gate
            (no icp_verdict field). off_icp leads are REMOVED from the batch file
            and appended to vault/leads/off-icp/retro__<file>. Others get tagged
            icp_verdict/icp_reason/icp_confidence, exactly like the live gate.

  --verify  (run with /usr/bin/python3; Reacher must be up)
            Re-check deliverability of leads in batches older than --age-days
            (default 30). Hard-rejected emails move to vault/leads/stale/retro__<file>;
            the rest get verification_status refreshed + last_reverified stamped.

SCOPE GUARDS (both phases):
  - only manifest-ACTIVE warehouse files (warehouse_manifest.py)
  - only UNCONTACTED companies (registrable domain not on the truth board) — we never
    reclassify or remove a company we're already talking to
  - DNC domains skipped (they're suppressed downstream anyway; don't waste fetches)
  - every modified file is backed up first to vault/leads/.retro-backup-<date>/

  --dry-run reports what would happen, writes nothing.
"""
import argparse
import json
import shutil
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
from lead_guards import registrable_root
from warehouse_manifest import active_files

VAULT = Path.home() / "velab" / "vault"
BOARD = VAULT / "state" / "board.json"
OFFICP_DIR = VAULT / "leads" / "off-icp"
STALE_DIR = VAULT / "leads" / "stale"
BACKUP_DIR = VAULT / "leads" / f".retro-backup-{date.today()}"


def load_leads(path):
    """Return (leads_list, container, key) preserving file shape for writeback."""
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return data, None, None
    for k in ("leads", "results"):
        if isinstance(data.get(k), list):
            return data[k], data, k
    return [], data, None


def write_leads(path, leads, container, key, dry):
    if dry:
        return
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    bak = BACKUP_DIR / path.name
    if not bak.exists():
        shutil.copy2(path, bak)
    if container is None:
        payload = leads
    else:
        container[key] = leads
        payload = container
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))


def contacted_domains():
    doms = set()
    for c in json.loads(BOARD.read_text()).get("companies", []):
        d = registrable_root(c.get("key") or "")
        if d:
            doms.add(d)
    return doms


def dnc_domains():
    from verify_email import load_dnc_domains
    return load_dnc_domains()


def lead_domain(ld):
    email = (ld.get("email") or "").lower()
    return registrable_root(email.split("@")[-1]) if "@" in email else ""


def sidecar_append(dirpath, fname, items, dry):
    if dry or not items:
        return
    dirpath.mkdir(parents=True, exist_ok=True)
    p = dirpath / f"retro__{fname}"
    existing = json.loads(p.read_text()) if p.exists() else []
    existing.extend(items)
    p.write_text(json.dumps(existing, indent=2, ensure_ascii=False))


def phase_icp(args, skip_doms):
    from icp_classify import _load_lexicon, classify_text
    import qualify
    params, lex = _load_lexicon()
    totals = defaultdict(int)

    for f in active_files():
        leads, container, key = load_leads(f)
        todo = defaultdict(list)  # domain -> leads needing a verdict
        for ld in leads:
            dom = lead_domain(ld)
            if not dom or dom in skip_doms or ld.get("icp_verdict"):
                continue
            todo[dom].append(ld)
        if not todo:
            continue

        def _profile(dom):
            url = todo[dom][0].get("source_url") or f"https://{dom}/"
            try:
                ev = qualify.profile(url, max_pages=args.max_pages, include_text=True)
            except Exception as e:
                ev = {"_fulltext": "", "error": str(e)}
            return dom, classify_text(ev.get("_fulltext", ""), params, lex)

        verdicts = {}
        with ThreadPoolExecutor(max_workers=min(args.workers, len(todo))) as ex:
            for dom, v in ex.map(_profile, list(todo)):
                verdicts[dom] = v

        kept, dropped = [], []
        for ld in leads:
            dom = lead_domain(ld)
            v = verdicts.get(dom)
            if v is None or ld.get("icp_verdict") and dom not in verdicts:
                kept.append(ld)
                continue
            ld["icp_verdict"] = v["verdict"]
            ld["icp_reason"] = v["reason"]
            ld["icp_confidence"] = "deterministic-retro"
            ld["icp_match"] = v["verdict"] != "off_icp"
            (dropped if v["verdict"] == "off_icp" else kept).append(ld)
            totals[v["verdict"]] += 1

        if dropped:
            sidecar_append(OFFICP_DIR, f.name, dropped, args.dry_run)
        if dropped or any(verdicts):
            write_leads(f, kept, container, key, args.dry_run)
        print(f"{f.name}: classified {sum(len(v) for v in todo.values())} leads "
              f"({len(todo)} domains), removed {len(dropped)} off-ICP"
              + (" [DRY]" if args.dry_run else ""))
    print(f"\nICP totals: {dict(totals)}")


def phase_verify(args, skip_doms):
    from verify_email import verify_single, reacher_alive
    ok, detail = reacher_alive()
    if not ok:
        sys.exit(f"reacher preflight failed: {detail}")
    today = date.today()
    totals = defaultdict(int)

    for f in active_files():
        try:
            bdate = date.fromisoformat(f.name[:10])
            age = (today - bdate).days
        except ValueError:
            age = 9999
        if age < args.age_days:
            continue
        leads, container, key = load_leads(f)
        todo = [ld for ld in leads
                if lead_domain(ld) and lead_domain(ld) not in skip_doms
                and ld.get("email") and ld.get("last_reverified") != str(today)]
        if not todo:
            continue
        if args.dry_run:
            print(f"{f.name}: would re-verify {len(todo)} leads (age {age}d) [DRY]")
            totals["would_verify"] += len(todo)
            continue

        def _check(ld):
            return ld, verify_single(ld["email"], ld)

        kept, stale = [], []
        results = {}
        with ThreadPoolExecutor(max_workers=min(args.workers, len(todo))) as ex:
            for ld, res in ex.map(_check, todo):
                results[id(ld)] = res
        for ld in leads:
            res = results.get(id(ld))
            if res is None:
                kept.append(ld)
                continue
            ld["last_reverified"] = str(today)
            v = res["verdict"]
            if v == "rejected":
                ld["verification_status"] = "invalid"
                ld["reverify_reason"] = res.get("reason", "")
                stale.append(ld)
                totals["stale"] += 1
            else:
                if v == "verified":
                    ld["verification_status"] = "valid"
                    totals["still_valid"] += 1
                else:
                    ld["verification_status"] = ld.get("verification_status") or "unknown"
                    totals["inconclusive"] += 1
                kept.append(ld)
        if stale:
            sidecar_append(STALE_DIR, f.name, stale, args.dry_run)
        write_leads(f, kept, container, key, args.dry_run)
        print(f"{f.name}: re-verified {len(todo)} (age {age}d), demoted {len(stale)} dead")
    print(f"\nVERIFY totals: {dict(totals)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--icp", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--age-days", type=int, default=30)
    ap.add_argument("--max-pages", type=int, default=3)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not (args.icp or args.verify):
        sys.exit("pick a phase: --icp and/or --verify")
    skip = contacted_domains() | set(dnc_domains())
    if args.icp:
        phase_icp(args, skip)
    if args.verify:
        phase_verify(args, skip)
