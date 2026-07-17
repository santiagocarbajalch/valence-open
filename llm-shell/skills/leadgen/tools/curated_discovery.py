#!/opt/scrapling-venv/bin/python3
"""Curated-source discovery — harvest distributor domains from pre-qualified seed pages.

Unlike generic search (~30-40% precision; see source_discovery.py), a curated seed is a page
that ALREADY lists real distributors: a manufacturer's authorized-dealer/where-to-buy page, a
country lab-equipment business-directory category, an industry-association member roster, or a
trade-show exhibitor list. This tool fetches each seed, extracts the OUTBOUND company-domain
links on the page, drops junk/wrong-country/self domains, dedups against the source registry,
and emits the same `new_candidates` JSON contract as source_discovery.py — so the normal
scrape -> verify -> ICP-filter pipeline takes over unchanged.

Rebuilt 2026-06-21 (operator lead-growth initiative). The original harvester was lost in the
VPS teardown migration (only dangling symlinks remained); the curated_seeds.json data file
survived. This reuses source_discovery internals + scrape_contacts.fetch.

Seeds live in data/curated_seeds.json with sections: manufacturer_locators, directories,
associations, trade_shows. Each entry: {url, render(static|js), and optional country/brand/name}.

Usage:
    curated_discovery.py --country Brazil                 # all seeds matching Brazil (+ global locators)
    curated_discovery.py --section manufacturer_locators  # one section, all geos
    curated_discovery.py --country "South Africa" --max 40
    curated_discovery.py --list-seeds
"""

import argparse
import datetime
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse, urljoin

import source_discovery as sd
import scrape_contacts
from lead_guards import registrable_root as _shared_reg_root   # canonical, single source of truth

THIS_DIR = Path(__file__).resolve().parent
SEEDS_PATH = THIS_DIR / "data" / "curated_seeds.json"
# Tunnel ledger — one append-only record per (seed, run): the durable memory of which
# tunnels are dug, so passes rotate to fresh seams instead of re-digging tapped-out ones.
LEDGER_PATH = Path("/opt/velab/vault/leads/discovery-paths.jsonl")
TOOL_VERSION = "1.2.0-curated"

HREF_RE = re.compile(r'href\s*=\s*["\']([^"\']+)["\']', re.IGNORECASE)

# Many directory pages (PharmChoices/Africa, THAIMED) print company domains as PLAIN TEXT, not
# <a href> — anchor-only harvest yields ~0. Also scan bare-text domains. TLD allowlist (gTLDs +
# real ccTLDs) so we don't match file extensions (.js/.css/.png). Filters downstream clean the rest.
_GTLDS = "com|net|org|info|biz|health|africa|asia|store|online|tech|life|care|med"
BARE_DOMAIN_RE = re.compile(
    r'(?<![@\w.])((?:[a-z0-9][a-z0-9\-]{0,61}\.)+(?:' + _GTLDS + r'|[a-z]{2}))(?![\w@])', re.I)
_BARE_BAD_PREFIX = ("2f", "3a")   # url-encoded junk like 2Fpharmchoices.com


def _page_html(page) -> str:
    """Reuse scrape_contacts.body_text (decodes page.body bytes -> str)."""
    try:
        return scrape_contacts.body_text(page)
    except Exception:
        raw = getattr(page, "body", "") or ""
        return raw.decode("utf-8", "ignore") if isinstance(raw, bytes) else str(raw)


def _root_host(url: str) -> str:
    h = (urlparse(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


# Second-level labels that, combined with a 2-letter ccTLD, form a public suffix
# (com.br, co.za, com.pe, gob.mx...) — needed to find the registrable root before collapse.
_SLD_SUFFIXES = {"com", "co", "net", "org", "gob", "gov", "edu", "ac", "go",
                 "or", "ind", "mil", "biz", "info"}

# Subdomain first-labels that are NEVER a distributor's storefront -> drop the host outright.
_INFRA_SUBDOMAINS = {"cdn", "cdn2", "static", "assets", "asset", "img", "imgs", "images",
                     "image", "media", "mail", "webmail", "smtp", "imap", "pop", "mx",
                     "ns", "ns1", "ns2", "dns", "ftp", "vpn", "autodiscover", "autoconfig",
                     "files", "downloads", "fonts", "track", "tracking", "analytics",
                     "cp", "cpanel", "whm", "status"}


def _registrable_root(host: str) -> str:
    """Registrable root — delegates to the canonical lead_guards.registrable_root."""
    return _shared_reg_root(host)


def _collapse_host(host: str) -> str | None:
    """Collapse a harvested host to its registrable root for dedup; drop pure-infra
    subdomains outright. blog./shop./manuals.* -> root, cdn./static./mail.* -> dropped.
    Fixes the manufacturer-locator leak where one brand spawned dozens of subdomain 'leads'."""
    root = _registrable_root(host)
    if host == root:
        return root
    sub_first = host[:-(len(root) + 1)].split(".")[-1]   # label immediately left of the root
    if sub_first in _INFRA_SUBDOMAINS:
        return None
    return root


def _wrong_country(host: str, country: str) -> bool:
    """Curated geo gate: the SEED already pre-qualifies geo, so we only REJECT a host that
    carries a *different* country's ccTLD. gTLD (.com/.org/.net) and the target ccTLD pass —
    we trust the seed (matches the country-aware curated note in curated_seeds._meta)."""
    gate = sd.COUNTRY_GATES.get(country)
    target_cc = gate["cctld"] if gate else None
    if target_cc and host.endswith(target_cc):
        return False
    for cc in getattr(sd, "OTHER_CCTLDS", ()):
        if cc != target_cc and host.endswith(cc):
            return True
    return False


def _junk(host: str) -> bool:
    if not host or "." not in host:
        return True
    if host.endswith(getattr(sd, "FOREIGN_VENDOR_TLDS", ())):
        return True
    for s in getattr(sd, "NEG_DOMAIN_SUBSTRINGS", ()):
        if s in host:
            return True
    for s in getattr(sd, "NOISE_DOMAIN_SUBSTRINGS", ()):
        if s in host:
            return True
    # social / marketplace / generic platforms + asset/CDN hosts that are never the distributor
    PLATFORMS = ("facebook.", "instagram.", "linkedin.", "twitter.", "x.com", "youtube.",
                 "wa.me", "whatsapp.", "google.", "maps.google", "mercadolibre", "mercadolivre",
                 "amazon.", "alibaba.", "wikipedia.", "blogspot.", "wordpress.com", "medium.com",
                 "gravatar.", "gstatic.", "googleapis.", "cloudflare.", "w3.org", "schema.org",
                 "typekit.", "flowpaper.com", "bigcommerce.com", "jsdelivr.", "fonts.", "cdn.",
                 "jquery.", "bootstrapcdn.", "fontawesome.", "youtu.be", "vimeo.", "pinterest.",
                 "tiktok.", "t.me", "paypal.", "addthis.", "sharethis.", "doubleclick.")
    return any(p in host for p in PLATFORMS)


def _brand_stem(seed_url: str) -> str:
    """First ~5 alpha chars of the seed's registrable label, to suppress the brand's OWN
    family domains (a brand's dealer locator often links to its own regional sites — not third parties)."""
    host = _root_host(seed_url)
    label = host.split(".")[0] if host else ""
    m = re.match(r"[a-z]+", label)
    stem = m.group(0) if m else label
    return stem[:5] if len(stem) >= 5 else stem


def select_seeds(seeds: dict, country: str | None, section: str | None) -> list[dict]:
    out = []
    sections = [section] if section else ["manufacturer_locators", "directories",
                                          "associations", "trade_shows"]
    for sec in sections:
        for entry in seeds.get(sec, []):
            if not isinstance(entry, dict) or not entry.get("url"):
                continue
            ec = entry.get("country")
            # manufacturer_locators are global gateways (no country) -> always in scope.
            # country-scoped seeds (directories/associations/trade_shows) match the target.
            if country and ec and ec.lower() != country.lower():
                continue
            out.append({**entry, "_section": sec})
    return out


def harvest(country: str | None, section: str | None, max_candidates: int,
            per_seed_timeout: int = 30) -> dict:
    seeds_doc = json.loads(SEEDS_PATH.read_text())
    seeds = select_seeds(seeds_doc, country, section)
    registry_loader = sd.load_registry()
    registry = registry_loader.load()

    seen: dict[str, dict] = {}
    per_seed = []
    raw_links = 0

    for s in seeds:
        url = s["url"]
        seed_host = _root_host(url)
        brand_stem = _brand_stem(url) if s["_section"] == "manufacturer_locators" else ""
        rec = {"seed": url, "section": s["_section"], "render": s.get("render", "static"),
               "raw": 0, "kept": 0, "error": None}
        try:
            page, _tier = scrape_contacts.fetch(url, mode="auto")
            html = _page_html(page)
        except Exception as e:
            rec["error"] = f"{type(e).__name__}: {e}"[:160]
            per_seed.append(rec)
            continue

        hosts = set()
        for m in HREF_RE.finditer(html or ""):
            href = m.group(1).strip()
            if href.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
                continue
            full = urljoin(url, href)
            h = _root_host(full)
            if h:
                hosts.add(h)
        # plain-text domains (directory pages that print, not link, company sites)
        for m in BARE_DOMAIN_RE.finditer(html or ""):
            h = m.group(1).lower().lstrip(".")
            if h.startswith("www."):
                h = h[4:]
            if "." in h and not any(h.startswith(p) for p in _BARE_BAD_PREFIX):
                hosts.add(h)
        rec["raw"] = len(hosts)
        raw_links += len(hosts)

        for h_raw in hosts:
            h = _collapse_host(h_raw)                    # subdomain collapse + infra drop
            if not h:
                continue
            if h == seed_host:                          # self / brand's own pages
                continue
            if brand_stem and len(brand_stem) >= 4 and h.split(".")[0].startswith(brand_stem):
                continue                                 # brand's own family domains (hanna*)
            root = sd.normalize_root(f"https://{h}/")   # applies EXCLUDE_DOMAINS
            if not root:
                continue
            if _junk(h):
                continue
            if country and _wrong_country(h, country):
                continue
            if sd.already_in_registry(registry_loader, registry, root):
                continue
            if h not in seen:
                seen[h] = {"url": root, "domain": h, "via_seed": url,
                           "section": s["_section"], "title": ""}
                rec["kept"] += 1
        per_seed.append(rec)

    candidates = list(seen.values())[:max_candidates]
    return {
        "mode": "curated",
        "country": country or "(all)",
        "section": section or "(all)",
        "seeds_used": len(seeds),
        "seeds_reached": sum(1 for r in per_seed if r["error"] is None),
        "raw_outbound_domains": raw_links,
        "candidates_after_filter": len(seen),
        "new_candidates": candidates,
        "per_seed": per_seed,
        "tool_version": TOOL_VERSION,
    }


def record_ledger(out: dict, run_date: str | None = None) -> None:
    """Append one record per seed touched this run to the tunnel ledger (JSONL)."""
    run_date = run_date or datetime.date.today().isoformat()
    try:
        LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LEDGER_PATH.open("a", encoding="utf-8") as f:
            for r in out.get("per_seed", []):
                f.write(json.dumps({
                    "date": run_date,
                    "seed": r["seed"],
                    "section": r["section"],
                    "country": out.get("country"),
                    "raw": r["raw"],
                    "kept": r["kept"],          # NET-NEW after registry dedup
                    "error": r["error"],
                }, ensure_ascii=False) + "\n")
    except Exception as e:                       # ledger is best-effort, never break a harvest
        print(f"[ledger] warning: {e}", file=sys.stderr)


def report_paths(as_json: bool = False) -> None:
    """Tunnel-status report: which seeds are productive, tapped-out, or never dug (fresh).
    A tunnel is TAPPED OUT when its last two reached runs both returned 0 net-new (raw>0)
    — it still lists companies, but we already have them all. FRESH = in seeds, never run."""
    doc = json.loads(SEEDS_PATH.read_text())
    seeds = {e["url"]: e for sec in ("manufacturer_locators", "directories", "associations",
                                     "trade_shows") for e in doc.get(sec, []) if e.get("url")}
    runs: dict[str, list] = defaultdict(list)
    icp: dict[str, dict] = defaultdict(lambda: {"icp_valid": 0, "off_icp": 0})
    if LEDGER_PATH.exists():
        for line in LEDGER_PATH.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("type") == "icp_outcome":   # downstream ICP yield written by icp_classify
                icp[rec["seed"]]["icp_valid"] += rec.get("icp_valid", 0)
                icp[rec["seed"]]["off_icp"] += rec.get("off_icp", 0)
            elif "seed" in rec:
                runs[rec["seed"]].append(rec)

    def status(url):
        rs = sorted(runs.get(url, []), key=lambda r: r.get("date", ""))
        if not rs:
            return "FRESH", 0, "-", 0
        reached = [r for r in rs if not r.get("error")]
        last_kept = reached[-1]["kept"] if reached else 0
        total_kept = sum(r["kept"] for r in reached)
        last_date = rs[-1].get("date", "-")
        if reached and reached[-1].get("error") is None and all(r["kept"] == 0 and r["raw"] > 0
                                                                for r in reached[-2:]):
            st = "TAPPED-OUT"
        elif not reached:
            st = "ERROR"
        else:
            st = "PRODUCTIVE"
        return st, last_kept, last_date, total_kept

    rows = []
    for url, e in seeds.items():
        st, last_kept, last_date, total = status(url)
        iv = icp.get(url, {})
        icp_valid, off = iv.get("icp_valid", 0), iv.get("off_icp", 0)
        icp_total = icp_valid + off
        icp_pct = f"{round(100 * icp_valid / icp_total)}%" if icp_total else "-"
        # DRY-ICP: discovery is alive but downstream ICP yield is zero — a noisy seam
        # (e.g. an industry-chamber roster) that looks productive but lands no real leads.
        if icp_total and icp_valid == 0 and st in ("PRODUCTIVE", "FRESH"):
            st = "DRY-ICP"
        rows.append((st, total, last_kept, last_date, e.get("country", "global"),
                     (e.get("brand") or e.get("name") or url)[:30], url, icp_pct, icp_valid))
    order = {"FRESH": 0, "PRODUCTIVE": 1, "TAPPED-OUT": 2, "DRY-ICP": 3, "ERROR": 4}
    rows.sort(key=lambda r: (order.get(r[0], 9), -r[1]))
    if as_json:                                  # machine consumers (the console) — same rows
        print(json.dumps({"tunnels": [
            {"status": st, "total_kept": total, "last_kept": last_kept, "last_run": last_date,
             "country": geo, "name": name, "url": url, "icp_pct": icp_pct}
            for st, total, last_kept, last_date, geo, name, url, icp_pct, _ in rows
        ]}, ensure_ascii=False))
        return
    print(f"{'STATUS':11} {'TOTAL':>6} {'LAST':>5} {'ICP%':>5} {'LAST-RUN':10} {'GEO':14} SEED")
    for st, total, last_kept, last_date, geo, name, url, icp_pct, icp_valid in rows:
        print(f"{st:11} {total:>6} {last_kept:>5} {icp_pct:>5} {last_date:10} {geo:14} {name}")
    fresh = sum(1 for r in rows if r[0] == "FRESH")
    print(f"\n{len(rows)} tunnels — {fresh} fresh (never dug), "
          f"{sum(1 for r in rows if r[0]=='PRODUCTIVE')} productive, "
          f"{sum(1 for r in rows if r[0]=='TAPPED-OUT')} tapped-out, "
          f"{sum(1 for r in rows if r[0]=='DRY-ICP')} dry-ICP (discovery alive, 0 ICP yield). "
          f"\nICP% = downstream distributor+adjacent yield per seed (written by icp_classify). Ledger: {LEDGER_PATH}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", default=None)
    ap.add_argument("--section", default=None,
                    choices=["manufacturer_locators", "directories", "associations", "trade_shows"])
    ap.add_argument("--max", type=int, default=40)
    ap.add_argument("--list-seeds", action="store_true")
    ap.add_argument("--report", action="store_true", help="print tunnel-status report and exit")
    ap.add_argument("--json", action="store_true", help="with --report: emit JSON rows")
    ap.add_argument("--no-ledger", action="store_true", help="do not record this run to the ledger")
    ap.add_argument("--date", default=None, help="override run date (YYYY-MM-DD) for the ledger")
    args = ap.parse_args()

    if args.report:
        report_paths(as_json=args.json)
        return

    if args.list_seeds:
        doc = json.loads(SEEDS_PATH.read_text())
        for sec in ("manufacturer_locators", "directories", "associations", "trade_shows"):
            entries = doc.get(sec, [])
            print(f"\n## {sec} ({len(entries)})")
            for e in entries:
                if isinstance(e, dict) and e.get("url"):
                    tag = e.get("brand") or e.get("name") or ""
                    print(f"  [{e.get('country','global'):14}] {e.get('render','static'):6} {tag[:28]:28} {e['url']}")
        return

    out = harvest(args.country, args.section, args.max)
    if not args.no_ledger:
        record_ledger(out, args.date)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
