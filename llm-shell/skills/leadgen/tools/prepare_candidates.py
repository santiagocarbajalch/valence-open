#!/opt/scrapling-venv/bin/python3
"""prepare_candidates.py — turn a curated_discovery harvest into a clean, scrape-ready URL list.

Replaces the manual per-batch triage (done by hand 5x on 2026-06-22): drop manufacturer-HQ
domains, scrape-junk, off-ICP-by-name, and wrong-country ccTLDs — keep real in-territory
distributor candidates. Makes a geo dig durable: one command instead of hand-splitting .ar/.com
and eyeballing global HQs every batch.

  curated_discovery.py --section associations --country Argentina > cand.json
  prepare_candidates.py cand.json --country Argentina --out /tmp/ar-urls.txt
  # -> writes clean urls.txt, prints a kept/dropped report (by reason)

Drops, with reason, are PRINTED so nothing vanishes silently. --keep-hq / --keep-all to relax.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import source_discovery as sd
from lead_guards import registrable_root as _reg_root   # canonical, single source of truth

# Global manufacturer / multinational brands — they make the product, they don't BUY from Velab.
# Matched on the registrable-root's first label (so roche.com AND roche.co.za both drop — a local
# manufacturer subsidiary is still not a distributor lead). Keep stems >=4 chars to avoid collisions.
MANUFACTURER_BRANDS = {
    "metrohm", "mettler", "roche", "abbott", "biorad", "bio-rad", "beckmancoulter", "beckman",
    "siemens", "cepheid", "gehealthcare", "bostonscientific", "medtronic", "draeger", "karlstorz",
    "icumed", "agfahealthcare", "agfa", "terumobct", "terumo", "westpharma", "instron", "sysmex",
    "thermofisher", "thermo", "sartorius", "hannainst", "kern-sohn", "ohaus", "qiagen", "euroimmun",
    "tosohbioscience", "tosoh", "nihonkohden", "zimmerbiomet", "cookmedical", "bbraun", "nipro",
    "fresenius", "philips", "alcon", "coloplast", "ansell", "bausch", "edwards", "elekta",
    "convatec", "medel", "zeiss", "haemonetics", "klsmartin", "ascensia", "bayer", "danaher",
    "shimadzu", "agilent", "perkinelmer", "waters", "merck", "eppendorf", "hettich", "binder",
    "memmert", "ika", "buchi", "metrohm", "endress", "honeywell", "emerson", "yokogawa",
}
# Short-stem HQ domains the brand-stem rule can't safely match (stem too generic/collision-prone).
EXACT_HQ_DOMAINS = {
    "bd.com", "mt.com", "3m.com", "ge.com", "jnj.com", "jnjarg.com", "dksh.com",
}

# Self-learning denylist — registrable roots that icp_classify.py flagged as manufacturer-HQ
# or that an operator/agent recorded as off-ICP after a spot-check. Loaded at runtime so a
# slip caught ONCE auto-drops on every future pass (no more editing MANUFACTURER_BRANDS by
# hand). Written by icp_classify.py and `prepare_candidates.py --learn`. 2026-06-24 review.
_LEARNED_PATH = Path(__file__).resolve().parent / "data" / "learned_off_icp.json"


def _load_learned():
    try:
        d = json.loads(_LEARNED_PATH.read_text())
        return set(d.get("manufacturer_hq", [])) | set(d.get("off_icp", []))
    except Exception:
        return set()


LEARNED_DENY = _load_learned()

# Non-company domains scrapers attach to the wrong site: trackers, CDNs, theme/asset hosts,
# directory siblings, generic SaaS. Matched as substrings of the registrable root.
JUNK_SUBSTR = (
    "googletagmanager", "gmpg", "w3.org", "schema.org", "sentry", "cloudflare", "jsdelivr",
    "example-theme-vendor", "example-asset-host", "serviciodecorreo", "cookiedatabase", "force.com",
    "salesforce", "wixsite", "wordpress.com", "blogspot", "trangvang", "niengiam", "yellowpages",
    "paginasamarillas", "jimdo", "godaddy", "hostgator", "bigcommerce", "shopify",
)

# Off-ICP-by-name tokens (broad-industrial noise a university mech-eng directory surfaced). A domain
# whose name screams non-lab gets dropped pre-scrape. Conservative — only unambiguous non-ICP.
NEG_ICP_TOKENS = (
    "yamaha", "homecenter", "tornillo", "ferreteria", "motos", "moto-", "rodachin", "rueda",
    "vidrios", "plasticos", "abcmetal", "makrooffice", "lubricante", "construc", "inmobil",
    "viajes", "turismo", "restaurant", "hotel", "seguros", "abogad", "contador", "auditor",
)


def classify(domain: str, country: str, keep_hq: bool):
    root = _reg_root(domain)
    label0 = root.split(".")[0]
    # wrong-country ccTLD (curated_discovery usually pre-filters, but .com slips can be foreign)
    gate = sd.COUNTRY_GATES.get(country)
    target_cc = gate["cctld"] if gate else None
    for cc in getattr(sd, "OTHER_CCTLDS", ()):
        if cc != target_cc and domain.endswith(cc):
            return "drop", f"wrong-geo ccTLD ({cc})"
    if any(j in root for j in JUNK_SUBSTR):
        return "drop", "junk/non-company"
    if any(t in root for t in NEG_ICP_TOKENS):
        return "drop", "off-ICP by name"
    if not keep_hq and root in LEARNED_DENY:
        return "drop", f"learned off-ICP/HQ ({root})"
    if not keep_hq and (label0 in MANUFACTURER_BRANDS or root in EXACT_HQ_DOMAINS):
        return "drop", f"manufacturer HQ ({root})"
    return "keep", ""


def _learn(domains, kind="off_icp"):
    """Record registrable roots into the self-learning denylist so future passes drop them."""
    key = "manufacturer_hq" if kind == "hq" else "off_icp"
    learned = {"manufacturer_hq": [], "off_icp": []}
    if _LEARNED_PATH.exists():
        try:
            learned = json.loads(_LEARNED_PATH.read_text())
        except Exception:
            pass
    learned.setdefault(key, [])
    added = []
    for d in domains:
        r = _reg_root(d)
        if r and r not in learned[key]:
            learned[key].append(r); added.append(r)
    _LEARNED_PATH.write_text(json.dumps(learned, ensure_ascii=False, indent=2))
    return added


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("candidates", nargs="?", help="curated_discovery output JSON (has new_candidates[])")
    ap.add_argument("--country", help="(required unless --learn)")
    ap.add_argument("--out", help="write clean urls here (one per line); required unless --learn")
    ap.add_argument("--keep-hq", action="store_true", help="do not drop manufacturer-HQ domains")
    ap.add_argument("--keep-all", action="store_true", help="emit every candidate (report only)")
    ap.add_argument("--learn", nargs="+", metavar="DOMAIN",
                    help="record domain(s) into the self-learning denylist, then exit")
    ap.add_argument("--learn-kind", choices=["off_icp", "hq"], default="off_icp",
                    help="bucket for --learn (default off_icp)")
    a = ap.parse_args()

    if a.learn:
        added = _learn(a.learn, a.learn_kind)
        print(f"learned [{a.learn_kind}] +{len(added)}: {', '.join(added) or '(all already present)'}")
        return
    if not a.candidates or not a.country or not a.out:
        ap.error("candidates, --country and --out are required (unless --learn)")

    doc = json.loads(Path(a.candidates).read_text())
    cands = doc.get("new_candidates", doc if isinstance(doc, list) else [])
    kept, dropped = [], {}
    for c in cands:
        dom = c.get("domain") or ""
        verdict, reason = ("keep", "") if a.keep_all else classify(dom, a.country, a.keep_hq)
        if verdict == "keep":
            kept.append(c["url"])
        else:
            dropped.setdefault(reason, []).append(dom)

    Path(a.out).write_text("\n".join(kept) + ("\n" if kept else ""))
    print(f"KEPT {len(kept)} / {len(cands)}  ->  {a.out}")
    for reason, doms in sorted(dropped.items(), key=lambda x: -len(x[1])):
        print(f"  DROP [{reason}] x{len(doms)}: {', '.join(sorted(doms)[:12])}{' …' if len(doms) > 12 else ''}")


if __name__ == "__main__":
    main()
