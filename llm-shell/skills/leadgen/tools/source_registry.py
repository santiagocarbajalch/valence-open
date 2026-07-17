#!/usr/bin/env python3
"""Source registry — tracks every URL/portal Explorador has scraped.

Lives at vault/leads/system/source_registry.json. Indexed by URL. Used by:
- scrape_orchestrator.py: pre-check to skip recently-scraped URLs
- source_discovery.py: filter new candidates to exclude already-scraped sources
- Operator: see "where have we been" per category/country

CLI:
    source_registry.py bootstrap                          # scan existing batches, rebuild registry
    source_registry.py check <url>                        # is this URL in the registry? when last scraped?
    source_registry.py record <url> --category X --country Y --emails N --verified-emails M [--discovered-via "..."]
    source_registry.py list [--category X] [--country Y] [--stale-after-days N]
    source_registry.py exhausted [--category X] [--country Y] [--threshold 5]  # report categories nearing exhaustion
    source_registry.py purge --before YYYY-MM-DD          # remove entries last_scraped before date
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_REGISTRY = Path("/opt/velab/vault/leads/system/source_registry.json")
RAW_DIR = Path("/opt/velab/vault/leads/raw")
VERIFIED_DIR = Path("/opt/velab/vault/leads/verified")
TOOL_VERSION = "1.0.0"


def empty_registry() -> dict:
    return {
        "_meta": {
            "description": "Per-source scrape history. Keyed by canonical URL. Updated on every scrape pass; consulted before any new scrape to avoid re-visiting recently-scraped sources.",
            "version": TOOL_VERSION,
            "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "default_revisit_days": 30,
        },
        "sources": {},
        "queries_used": [],
    }


def load(path: Path = DEFAULT_REGISTRY) -> dict:
    if not path.exists():
        return empty_registry()
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return empty_registry()


def save(data: dict, path: Path = DEFAULT_REGISTRY) -> None:
    data["_meta"]["last_updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def canonical_url(url: str) -> str:
    """Normalize URL for registry key — strip query, fragment, trailing slash, lowercase host."""
    if not url:
        return ""
    p = urlparse(url.strip())
    scheme = p.scheme.lower() or "https"
    host = p.hostname.lower() if p.hostname else ""
    path = (p.path or "/").rstrip("/") or "/"
    return f"{scheme}://{host}{path}"


def get(reg: dict, url: str) -> dict | None:
    return reg["sources"].get(canonical_url(url))


def record_scrape(
    reg: dict,
    url: str,
    category: str | None = None,
    country: str | None = None,
    emails_found: int = 0,
    verified_emails: int = 0,
    discovered_via: str | None = None,
    batch_id: str | None = None,
    scrape_date: str | None = None,
    error: str | None = None,
) -> dict:
    key = canonical_url(url)
    if not key:
        return {"error": "invalid url"}
    today = scrape_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    entry = reg["sources"].get(key)
    if entry is None:
        entry = {
            "url": key,
            "domain": urlparse(key).hostname or "",
            "client_category": category,
            "country": country,
            "first_scraped": today,
            "last_scraped": today,
            "scrape_count": 0,
            "emails_yielded_total": 0,
            "verified_emails_yielded_total": 0,
            "history": [],
            "discovered_via": discovered_via or "manual",
            "discovered_at": today,
            "status": "active",
        }
        reg["sources"][key] = entry
    entry["last_scraped"] = today
    entry["scrape_count"] += 1
    entry["emails_yielded_total"] += emails_found
    entry["verified_emails_yielded_total"] += verified_emails
    if category and not entry.get("client_category"):
        entry["client_category"] = category
    if country and not entry.get("country"):
        entry["country"] = country
    hist_event = {
        "date": today,
        "batch_id": batch_id,
        "emails_found": emails_found,
        "verified_emails": verified_emails,
    }
    if error:
        hist_event["error"] = error
    entry["history"].append(hist_event)
    # Cap history at last 20 entries
    if len(entry["history"]) > 20:
        entry["history"] = entry["history"][-20:]
    return entry


def record_query(reg: dict, query: str, category: str | None, country: str | None, results_promoted: int = 0) -> None:
    reg.setdefault("queries_used", []).append({
        "query": query,
        "category": category,
        "country": country,
        "used_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "results_promoted": results_promoted,
    })
    # Cap queries log at last 500
    reg["queries_used"] = reg["queries_used"][-500:]


def is_recently_scraped(reg: dict, url: str, within_days: int = 30) -> tuple[bool, dict | None]:
    entry = get(reg, url)
    if not entry:
        return False, None
    try:
        last = datetime.strptime(entry["last_scraped"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        if (datetime.now(timezone.utc) - last) <= timedelta(days=within_days):
            return True, entry
    except (ValueError, KeyError):
        pass
    return False, entry


def bootstrap_from_existing(reg: dict) -> dict:
    """Walk vault/leads/raw + vault/leads/verified and seed the registry from prior batches."""
    seeded = 0
    updated = 0
    for src_dir in (RAW_DIR, VERIFIED_DIR):
        if not src_dir.exists():
            continue
        for f in sorted(src_dir.glob("*.json")):
            try:
                data = json.loads(f.read_text())
            except (json.JSONDecodeError, FileNotFoundError):
                continue
            rows = data if isinstance(data, list) else data.get("leads", data.get("items", []))
            # Extract a batch date from filename if present
            m = re.search(r"(\d{4}-\d{2}-\d{2})", f.name)
            batch_date = m.group(1) if m else None
            # Group by source_url
            from collections import defaultdict
            by_url = defaultdict(lambda: {"emails": 0, "verified": 0, "category": None, "country": None})
            for r in rows:
                if not isinstance(r, dict):
                    continue
                src = r.get("source_url") or r.get("website") or r.get("directory_url")
                if not src:
                    continue
                by_url[src]["emails"] += 1
                if r.get("email_verified"):
                    by_url[src]["verified"] += 1
                if not by_url[src]["category"]:
                    by_url[src]["category"] = r.get("institution_type") or r.get("type")
                if not by_url[src]["country"]:
                    by_url[src]["country"] = r.get("country")
            for url, stats in by_url.items():
                key = canonical_url(url)
                if not key:
                    continue
                pre = key in reg["sources"]
                record_scrape(
                    reg, url,
                    category=stats["category"],
                    country=stats["country"],
                    emails_found=stats["emails"],
                    verified_emails=stats["verified"],
                    discovered_via="bootstrap-from-existing-batch",
                    batch_id=f.stem,
                    scrape_date=batch_date,
                )
                if pre:
                    updated += 1
                else:
                    seeded += 1
    return {"sources_seeded": seeded, "sources_updated": updated, "total_in_registry": len(reg["sources"])}


def list_sources(reg: dict, category: str | None = None, country: str | None = None, stale_after_days: int | None = None) -> list[dict]:
    today = datetime.now(timezone.utc).date()
    out = []
    for url, e in reg["sources"].items():
        if category and (e.get("client_category") or "").lower() != category.lower():
            continue
        if country and (e.get("country") or "").lower() != country.lower():
            continue
        if stale_after_days is not None:
            try:
                last = datetime.strptime(e["last_scraped"], "%Y-%m-%d").date()
                if (today - last).days < stale_after_days:
                    continue
            except (ValueError, KeyError):
                continue
        out.append({
            "url": e["url"],
            "client_category": e.get("client_category"),
            "country": e.get("country"),
            "last_scraped": e["last_scraped"],
            "scrape_count": e["scrape_count"],
            "verified_emails_yielded_total": e.get("verified_emails_yielded_total", 0),
            "discovered_via": e.get("discovered_via"),
        })
    out.sort(key=lambda x: (x["last_scraped"] or "", x["url"]), reverse=True)
    return out


def exhaustion_report(reg: dict, threshold: int = 5) -> dict:
    """Find (category, country) pairs that have many active sources but low recent yield —
    a sign we're saturating the existing pool and need source_discovery to find new ones."""
    from collections import defaultdict
    pairs = defaultdict(lambda: {"source_count": 0, "total_verified_yield": 0, "sources_yielding_zero": 0})
    for e in reg["sources"].values():
        key = (e.get("client_category") or "unknown", e.get("country") or "unknown")
        pairs[key]["source_count"] += 1
        pairs[key]["total_verified_yield"] += e.get("verified_emails_yielded_total", 0)
        if e.get("verified_emails_yielded_total", 0) == 0:
            pairs[key]["sources_yielding_zero"] += 1
    out = []
    for (cat, country), stats in pairs.items():
        if stats["source_count"] < threshold:
            continue
        yield_per_source = stats["total_verified_yield"] / stats["source_count"]
        out.append({
            "category": cat,
            "country": country,
            "source_count": stats["source_count"],
            "total_verified_yield": stats["total_verified_yield"],
            "sources_yielding_zero": stats["sources_yielding_zero"],
            "yield_per_source": round(yield_per_source, 2),
            "exhaustion_signal": yield_per_source < 0.5,
        })
    out.sort(key=lambda x: (x["exhaustion_signal"], -x["sources_yielding_zero"]))
    return {"pairs": out, "total_pairs": len(out)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("bootstrap", help="Rebuild registry from existing batch files in vault/leads/")
    p_check = sub.add_parser("check", help="Look up a URL")
    p_check.add_argument("url")
    p_check.add_argument("--within-days", type=int, default=30)

    p_record = sub.add_parser("record", help="Record a scrape event")
    p_record.add_argument("url")
    p_record.add_argument("--category")
    p_record.add_argument("--country")
    p_record.add_argument("--emails", type=int, default=0)
    p_record.add_argument("--verified-emails", type=int, default=0)
    p_record.add_argument("--discovered-via")
    p_record.add_argument("--batch-id")

    p_list = sub.add_parser("list", help="List sources, optionally filtered")
    p_list.add_argument("--category")
    p_list.add_argument("--country")
    p_list.add_argument("--stale-after-days", type=int)

    p_ex = sub.add_parser("exhausted", help="Report (category,country) pairs near exhaustion")
    p_ex.add_argument("--threshold", type=int, default=5)

    p_purge = sub.add_parser("purge", help="Remove entries last_scraped before a date")
    p_purge.add_argument("--before", required=True, help="YYYY-MM-DD")

    args = parser.parse_args()
    reg = load(args.registry)

    if args.cmd == "bootstrap":
        result = bootstrap_from_existing(reg)
        save(reg, args.registry)
    elif args.cmd == "check":
        recent, entry = is_recently_scraped(reg, args.url, args.within_days)
        result = {"url": canonical_url(args.url), "in_registry": entry is not None,
                  "recently_scraped": recent, "entry": entry}
    elif args.cmd == "record":
        entry = record_scrape(reg, args.url, category=args.category, country=args.country,
                              emails_found=args.emails, verified_emails=args.verified_emails,
                              discovered_via=args.discovered_via, batch_id=args.batch_id)
        save(reg, args.registry)
        result = {"recorded": entry}
    elif args.cmd == "list":
        result = {"sources": list_sources(reg, args.category, args.country, args.stale_after_days)}
    elif args.cmd == "exhausted":
        result = exhaustion_report(reg, args.threshold)
    elif args.cmd == "purge":
        cutoff = datetime.strptime(args.before, "%Y-%m-%d").date()
        before = len(reg["sources"])
        reg["sources"] = {u: e for u, e in reg["sources"].items()
                          if datetime.strptime(e.get("last_scraped", "1970-01-01"), "%Y-%m-%d").date() >= cutoff}
        save(reg, args.registry)
        result = {"removed": before - len(reg["sources"]), "remaining": len(reg["sources"])}
    else:
        parser.error("unknown command")

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
