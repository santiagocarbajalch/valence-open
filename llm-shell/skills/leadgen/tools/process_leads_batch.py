#!/usr/bin/env python3
import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys

# Reacher verification is network-bound (~tens of seconds per email on
# greylisting mailservers). Verify concurrently so a batch doesn't run
# sequentially for many minutes and trip the agent's exec timeout.
VERIFY_WORKERS = 8          # raised for LATAM volume; Reacher dedicated (nightly killed)
RETRY_DELAY_SECONDS = 8     # greylisting/transient timeouts clear on a 2nd probe

ROOT = Path.home() / "velab"
WORKSPACE = ROOT / "workspace"
VAULT = ROOT / "vault"

# ICP-geo hard exclusions: parent-company / out-of-doctrine territories. An email on one of
# these ccTLDs is rejected regardless of Reacher — catches scrape leaks where an in-territory
# site surfaces its foreign parent address (e.g. example-parent.com.ar -> ...@example-parent.mx, 2026-06-22).
EXCLUDED_TERRITORY_CCTLDS = (".mx", ".in")        # Mexico, India (MENA left to scoring config)
# Non-company domains a scraper sometimes attaches to the wrong institution (font foundries,
# theme/asset hosts, email-service shells, trackers) — never a real lead. Observed leaks + obvious.
JUNK_EMAIL_DOMAINS = {
    "example-theme-vendor.com", "example-asset-host.com", "serviciodecorreo.com", "googletagmanager.com",
    "gmpg.org", "w3.org", "schema.org", "sentry.io", "cloudflare.com", "jsdelivr.net",
}

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lead_guards import registrable_root as _reg_root   # canonical, single source of truth

RAW_DIR = VAULT / "leads" / "raw"
VERIFIED_DIR = VAULT / "leads" / "verified"
REJECTED_DIR = VAULT / "leads" / "rejected"
AUDIT_DIR = VAULT / "leads" / "audit"

# Import the skill's OWN (fixed) copies of these modules, not the live workspace ones.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lead_guards import dedupe_leads
from lead_registry import ensure_registry, filter_new_leads, register_leads, save_registry
from verify_email import verify_single, reacher_alive
import velab_batch as vb



def _load_scoring():
    """T2.12: load operator-editable scoring weights; fall back to built-in defaults."""
    defaults = {"fit": {"base": 40, "target_country": 20, "in_country_cctld": 10, "has_company_name": 15,
                "verification": {"valid": 15, "role_accepted": 12, "catch_all_accepted": 8, "relaxed_mx": 6, "unknown": 0, "invalid": -40}},
                "target_markets": ["Chile","Colombia","Peru","Ecuador","Dominican Republic","Panama","Costa Rica","Argentina","Bolivia","United Arab Emirates","Saudi Arabia","Egypt","Jordan","Bahrain","Morocco"],
                "cctld_by_country": {"Chile":".cl","Colombia":".co","Peru":".pe","Ecuador":".ec","Dominican Republic":".do","Panama":".pa","Costa Rica":".cr","Argentina":".ar","Bolivia":".bo","United Arab Emirates":".ae","Saudi Arabia":".sa","Egypt":".eg","Jordan":".jo","Bahrain":".bh","Morocco":".ma"}}
    try:
        import yaml  # type: ignore
        cfg = yaml.safe_load(open("/opt/velab/vault/reference/scoring.yaml", encoding="utf-8"))
        return cfg or defaults
    except Exception:
        return defaults

_SCORING = _load_scoring()

def compute_fit_score(item):
    """T2.12 deterministic fit_score (0-100) from static lead signals at mint time."""
    f = _SCORING.get("fit", {})
    score = f.get("base", 40)
    country = (item.get("country") or "").strip()
    markets = _SCORING.get("target_markets", [])
    if country and country in markets:
        score += f.get("target_country", 20)
    dom = (item.get("email") or "").lower().split("@")[-1]
    cctld = _SCORING.get("cctld_by_country", {}).get(country)
    if cctld and dom.endswith(cctld):
        score += f.get("in_country_cctld", 10)
    if (item.get("company") or item.get("institution") or "").strip():
        score += f.get("has_company_name", 15)
    score += f.get("verification", {}).get(item.get("verification_status", "valid"), 0)
    return max(0, min(100, int(score)))

def classify_leads(batch_path: Path):
    with batch_path.open() as f:
        data = json.load(f)

    leads = data if isinstance(data, list) else [data]
    verified, rejected, review = [], [], []
    stats = {
        "total": len(leads),
        "verified": 0,
        "rejected": 0,
        "inconclusive": 0,
        "catch_all": 0,
        "safe": 0,
        "risky": 0,
        "invalid": 0,
        "unknown": 0,
        "disposable_rejections": 0,
        "free_provider_rejections": 0,
    }

    items = []
    for lead in leads:
        item = dict(lead)
        item.pop("_raw_snippet", None)
        items.append(item)

    # Verify all emails concurrently (network-bound). Order is preserved so the
    # bucketing below is deterministic.
    def _verify(item):
        return verify_single(item.get("email"), item)

    if items:
        with ThreadPoolExecutor(max_workers=min(VERIFY_WORKERS, len(items))) as ex:
            verifications = list(ex.map(_verify, items))
        # Retry round: "reacher unknown" (greylisting) and "reacher error" (timeout) come
        # back flagged retry_later. A single re-probe after a short pause resolves most of
        # them -> they then hit the catch-all / role-inbox carve-out in verify_email.
        retry_idx = [i for i, v in enumerate(verifications) if "retry_later" in (v.get("flags") or [])]
        if retry_idx:
            time.sleep(RETRY_DELAY_SECONDS)
            with ThreadPoolExecutor(max_workers=min(VERIFY_WORKERS, len(retry_idx))) as ex:
                redo = list(ex.map(lambda i: (i, _verify(items[i])), retry_idx))
            for i, v2 in redo:
                # retry only upgrades; never downgrade an already-resolved verdict
                if "retry_later" not in (v2.get("flags") or []):
                    verifications[i] = v2
    else:
        verifications = []

    for item, verification in zip(items, verifications):
        # ICP-geo + junk hard rejects (override Reacher) — stops the manual scrubbing that
        # caught example-parent.mx and info@example-theme-vendor.com in the 2026-06-22 AR run.
        _dom = (item.get("email") or "").lower().rsplit("@", 1)[-1]
        if _dom.endswith(EXCLUDED_TERRITORY_CCTLDS):
            verification["verdict"] = "rejected"
            verification["reason"] = "excluded territory (ccTLD)"
            verification.setdefault("flags", []).append("geo_excluded")
        elif _dom in JUNK_EMAIL_DOMAINS:
            verification["verdict"] = "rejected"
            verification["reason"] = "non-company / scrape-artifact domain"
            verification.setdefault("flags", []).append("junk_domain")
        else:
            # institution!=domain guard: email on a DIFFERENT registrable domain than the page
            # it was scraped from = cross-entity scrape artifact (example-theme-vendor, example-cross-entity).
            # Downgrade verified -> review (recoverable), never hard-reject (legit alt mail domains exist).
            _src = item.get("source_url") or item.get("found_on_url") or ""
            _srcroot = _reg_root(_src.split("//")[-1].split("/")[0]) if _src else ""
            if (verification.get("verdict") == "verified" and _srcroot
                    and _reg_root(_dom) != _srcroot):
                verification["verdict"] = "inconclusive"
                verification.setdefault("flags", []).append("domain_mismatch")
                verification["reason"] = f"email domain != source domain ({_srcroot})"

        item["email_verified"] = verification["verdict"] == "verified"
        item["verification"] = verification

        # T2.6 status taxonomy + role flag: propagate verification confidence into
        # the lead record so the CRM and deliverability caps can segment (a 250-for-all
        # catch-all and a relaxed greylist promotion must not look like a hard SMTP valid).
        _flags = verification.get("flags", []) or []
        _v = verification["verdict"]
        _local = (item.get("email") or "").lower().split("@")[0]
        item["role_based"] = _local in {
            "info", "sales", "ventas", "contacto", "contact", "comercial", "gerencia",
            "administracion", "admin", "soporte", "atencion", "servicioalcliente",
            "mail", "correo", "hola", "hello", "ventas1", "asesor",
        }
        if _v == "rejected":
            item["verification_status"] = "invalid"
        elif _v == "inconclusive":
            item["verification_status"] = "catch_all" if "catch_all" in _flags else "unknown"
        elif "accepted_catch_all" in _flags:
            item["verification_status"] = "catch_all_accepted"
        elif "accepted_relaxed_unknown" in _flags:
            item["verification_status"] = "relaxed_mx"
        elif "accepted_risky" in _flags:
            item["verification_status"] = "role_accepted"
        else:
            item["verification_status"] = "valid"
        item["fit_score"] = compute_fit_score(item)
        item["intent_score"] = 0  # behavioral; updated by cadence/reply layer

        reachable = (verification.get("reacher") or {}).get("is_reachable")
        if reachable in stats:
            stats[reachable] += 1

        if verification["verdict"] == "verified":
            stats["verified"] += 1
            verified.append(item)
        elif verification["verdict"] == "rejected":
            stats["rejected"] += 1
            if verification.get("reason") == "disposable domain":
                stats["disposable_rejections"] += 1
            if verification.get("reason") == "free email provider without institutional affiliation":
                stats["free_provider_rejections"] += 1
            rejected.append(item)
        else:
            stats["inconclusive"] += 1
            item["review_flag"] = True
            if "catch_all" in verification.get("flags", []):
                item["catch_all"] = True
                stats["catch_all"] += 1
            review.append(item)

    verified, verified_dupes = dedupe_leads(verified)
    rejected, rejected_dupes = dedupe_leads(rejected)
    review, review_dupes = dedupe_leads(review)

    stats["verified_duplicates_removed"] = len(verified_dupes)
    stats["rejected_duplicates_removed"] = len(rejected_dupes)
    stats["review_duplicates_removed"] = len(review_dupes)
    stats["duplicates_removed_total"] = len(verified_dupes) + len(rejected_dupes) + len(review_dupes)

    audit = {
        "verified_duplicates_removed": verified_dupes,
        "rejected_duplicates_removed": rejected_dupes,
        "review_duplicates_removed": review_dupes,
    }

    return verified, rejected, review, stats, audit


def apply_registry_guards(batch_path: Path, verified, rejected, review, stats, audit, force_rebuild_registry: bool = False):
    batch_id = output_paths(batch_path)[0].stem.replace("-verified", "")
    registry = ensure_registry(force_rebuild=force_rebuild_registry)

    verified, verified_blocked, verified_upgrades = filter_new_leads(registry, verified, "verified", batch_id)
    rejected, rejected_blocked, rejected_upgrades = filter_new_leads(registry, rejected, "rejected", batch_id)
    review, review_blocked, review_upgrades = filter_new_leads(registry, review, "raw", batch_id)

    stats["registry_verified_blocked"] = len(verified_blocked)
    stats["registry_rejected_blocked"] = len(rejected_blocked)
    stats["registry_review_blocked"] = len(review_blocked)
    stats["registry_upgrades_total"] = len(verified_upgrades) + len(rejected_upgrades) + len(review_upgrades)
    stats["registry_blocks_total"] = len(verified_blocked) + len(rejected_blocked) + len(review_blocked)

    audit.update({
        "registry_verified_blocked": verified_blocked,
        "registry_rejected_blocked": rejected_blocked,
        "registry_review_blocked": review_blocked,
        "registry_verified_upgrades": verified_upgrades,
        "registry_rejected_upgrades": rejected_upgrades,
        "registry_review_upgrades": review_upgrades,
    })

    return verified, rejected, review, stats, audit, registry


def write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _email_key(lead):
    return (lead.get("email") or "").strip().lower()


def write_json_merged(path: Path, payload):
    """Merge new leads into any existing file at `path`, keyed by email (new wins).
    Prevents a same-batch re-run from clobbering a prior run's results."""
    existing = []
    if path.exists():
        try:
            prev = json.loads(path.read_text())
            existing = prev if isinstance(prev, list) else prev.get("leads", [])
        except Exception:
            existing = []
    merged, order = {}, []
    for lead in list(existing) + list(payload):
        k = _email_key(lead) or f"_noemail_{len(order)}"
        if k not in merged:
            order.append(k)
        merged[k] = lead
    write_json(path, [merged[k] for k in order])


def write_v1_verified(verified_dir: Path, leads, *, slug: str):
    """Write the verified batch under the v1 naming convention (date__client-type__
    geo[__variant].json), wrapped as a v1 dict with a status field. Merges by email
    into an existing same-named batch (idempotent re-run). Returns the path."""
    date = vb._modal(l.get("scrape_date") for l in leads) or time.strftime("%Y-%m-%d")
    base = vb.v1_basename(leads, slug=slug, date=date)
    path = verified_dir / f"{base}.json"
    existing = vb.load_batch_leads(path) if path.exists() else []
    merged, order = {}, []
    for lead in list(existing) + list(leads):
        k = _email_key(lead) or f"_noemail_{len(order)}"
        if k not in merged:
            order.append(k)
        merged[k] = lead
    final = [merged[k] for k in order]
    wrapper = vb.wrap_lead_batch(final, date=date, slug=slug, status="active",
                                 legacy_filename=None, batch_id=base)
    write_json(path, wrapper)
    return path


def output_paths(batch_path: Path):
    name = batch_path.name
    stem = batch_path.stem
    clean_stem = stem[6:] if stem.startswith("batch-") else stem
    verified_path = VERIFIED_DIR / f"{clean_stem}-verified.json"
    rejected_path = REJECTED_DIR / f"{clean_stem}-rejected.json"
    review_path = RAW_DIR / name
    audit_path = AUDIT_DIR / f"{clean_stem}-dedupe-audit.json"
    return verified_path, rejected_path, review_path, audit_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("batch", help="Path to raw batch JSON file")
    parser.add_argument("--pretty", action="store_true", help="Print summary as formatted JSON")
    parser.add_argument("--rebuild-registry", action="store_true", help="Rebuild the lead registry before processing")
    args = parser.parse_args()

    batch_path = Path(args.batch).expanduser().resolve()

    # Reacher liveness preflight: a hung backend would otherwise silently route every lead
    # to deferred/review. Abort loudly instead so the operator restarts Reacher and re-runs.
    ok, detail = reacher_alive()
    if not ok:
        print(json.dumps({
            "error": "reacher_preflight_failed",
            "detail": detail,
            "message": "Reacher is not responding — aborting verification so leads are not "
                       "silently dumped to deferred. Free/restart Reacher, then re-run.",
        }, indent=2 if args.pretty else None))
        sys.exit(2)

    verified, rejected, review, stats, audit = classify_leads(batch_path)
    verified, rejected, review, stats, audit, registry = apply_registry_guards(
        batch_path,
        verified,
        rejected,
        review,
        stats,
        audit,
        force_rebuild_registry=args.rebuild_registry,
    )
    verified_path, rejected_path, review_path, audit_path = output_paths(batch_path)
    # Verified batches follow the v1 naming convention + dict wrapper (status field).
    # Rejected/review stay as legacy bare arrays (intermediate, not operator-facing).
    clean_stem = verified_path.stem[:-len("-verified")] if verified_path.stem.endswith("-verified") else verified_path.stem
    verified_path = write_v1_verified(VERIFIED_DIR, verified, slug=clean_stem)

    write_json_merged(rejected_path, rejected)
    write_json(review_path, review)
    # T2.7: persist deferred-greylist leads to a re-verify queue. Greylisting clears
    # on a later attempt; a subsequent pass should re-verify these (same probe IP).
    deferred = [l for l in review if "deferred_greylist" in ((l.get("verification") or {}).get("flags") or [])]
    if deferred:
        ddir = VERIFIED_DIR.parent / "deferred"
        ddir.mkdir(parents=True, exist_ok=True)
        write_json(ddir / f"{clean_stem}-deferred.json", deferred)
        stats["deferred_greylist"] = len(deferred)
    write_json(audit_path, audit)

    register_leads(registry, verified, "verified", verified_path)
    register_leads(registry, rejected, "rejected", rejected_path)
    register_leads(registry, review, "raw", review_path)
    save_registry(registry)

    summary = {
        "batch": str(batch_path),
        "verified_count": len(verified),
        "rejected_count": len(rejected),
        "review_count": len(review),
        "catch_all_count": stats["catch_all"],
        "stats": stats,
        "verified_path": str(verified_path),
        "rejected_path": str(rejected_path),
        "review_path": str(review_path),
        "audit_path": str(audit_path),
        "duplicates_removed_total": stats["duplicates_removed_total"],
        "registry_blocks_total": stats["registry_blocks_total"],
        "registry_upgrades_total": stats["registry_upgrades_total"],
    }
    print(json.dumps(summary, indent=2 if args.pretty else None, ensure_ascii=False))


if __name__ == "__main__":
    main()
