#!/usr/bin/env python3
"""lead_rank.py — rank the uncontacted warehouse so pulls grab the best leads first.

Score per lead (0-100), transparent components:
  +35 * geo reply-rate prior   (from mine_outcomes; geos with <8 contacted get the
                                global average — small samples prove nothing)
  +25   buying-function inbox  (ventas@/comercial@/compras@/gerencia@... per doctrine)
  +15   ICP verdict            (distributor=15, adjacent=8, uncertain=3, none/missing=3)
  +10   named contact present  (name is a priority, never a requirement)
  +15   freshness              (linear decay, 0 at 180 days since batch date)

Already-contacted (on the truth board), DNC, and parked/.bak batches are EXCLUDED.
Output = ranked list. SUGGESTION ONLY — what gets pulled/sent is the operator's call.

Usage:
  /usr/bin/python3 lead_rank.py [--top 40] [--geo peru] [--json]
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lead_guards import registrable_root
from mine_outcomes import load_verified_origins, load_board, VERIFIED_DIR, SKIP_SUFFIXES, FNAME_RE
from verify_email import load_dnc_domains

BUYING_LOCALS = {"ventas", "comercial", "compras", "gerencia", "coordinacion",
                 "distribuidores", "info", "contacto", "contact", "sales",
                 "cotizaciones", "gerencia.comercial", "atencionalcliente"}
ICP_POINTS = {"distributor": 15, "adjacent": 8, "uncertain": 3}


def geo_priors():
    from mine_outcomes import build
    res = build()
    rates, weights = {}, {}
    tot_r = tot_c = 0
    for geo, v in res["geo"].items():
        c, r = v.get("contacted", 0), v.get("replied", 0)
        tot_c += c
        tot_r += r
        if c >= 8:
            rates[geo] = r / c
    global_avg = (tot_r / tot_c) if tot_c else 0.05
    return rates, global_avg


def iter_leads():
    from warehouse_manifest import active_files
    for f in active_files():
        m = FNAME_RE.match(f.name)
        bdate, cat, geo = (m.group(1), m.group(2), re.sub(r"__.*$", "", m.group(3))) if m else ("", "?", f.stem)
        try:
            data = json.loads(f.read_text())
        except Exception:
            continue
        leads = data if isinstance(data, list) else data.get("leads", data.get("results", []))
        if not isinstance(leads, list):
            continue
        for lead in leads:
            yield f.name, bdate, cat, geo, lead


def score_all():
    rates, global_avg = geo_priors()
    board = load_board()
    dnc = load_dnc_domains()
    today = date.today()

    best = {}  # domain -> best-scored lead (dedup by company)
    for fname, bdate, cat, geo, lead in iter_leads():
        email = (lead.get("email") or "").lower()
        if "@" not in email:
            continue
        dom = registrable_root(email.split("@")[-1])
        if not dom or dom in board or dom in dnc:
            continue

        prior = rates.get(geo, global_avg)
        s = 35 * min(prior / 0.15, 1.0)  # 15% reply rate or better = full marks

        local = email.split("@")[0]
        if local in BUYING_LOCALS or any(local.startswith(b) for b in ("ventas", "sales", "compras", "comercial")):
            s += 25
        s += ICP_POINTS.get(lead.get("icp_verdict"), 3)
        if (lead.get("contact_name") or "").strip():
            s += 10
        if bdate:
            try:
                age = (today - date.fromisoformat(bdate)).days
                s += 15 * max(0.0, 1 - age / 180)
            except ValueError:
                pass

        rec = {"score": round(s, 1), "email": email, "company": lead.get("institution") or dom,
               "geo": geo, "category": cat, "batch": fname,
               "name": lead.get("contact_name") or "", "icp": lead.get("icp_verdict") or "-",
               "batch_date": bdate}
        if dom not in best or rec["score"] > best[dom]["score"]:
            best[dom] = rec
    return sorted(best.values(), key=lambda r: -r["score"])


if __name__ == "__main__":
    args = sys.argv[1:]
    top = int(args[args.index("--top") + 1]) if "--top" in args else 40
    geo = args[args.index("--geo") + 1].lower() if "--geo" in args else None
    ranked = score_all()
    if geo:
        ranked = [r for r in ranked if r["geo"] == geo]
    ranked = ranked[:top]
    if "--json" in args:
        print(json.dumps(ranked, indent=2))
    else:
        print(f"{'score':>5}  {'email':40} {'geo':14} {'icp':11} {'age':>4}  company")
        for r in ranked:
            try:
                age = (date.today() - date.fromisoformat(r["batch_date"])).days
            except Exception:
                age = "?"
            print(f"{r['score']:>5}  {r['email'][:40]:40} {r['geo'][:14]:14} {r['icp'][:11]:11} {age:>4}  {r['company'][:38]}")
        print(f"\n{len(ranked)} shown. Suggestion only — pull/send is the operator's call.")
