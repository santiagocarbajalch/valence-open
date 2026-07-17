#!/opt/scrapling-venv/bin/python3
"""Batch scrape + verify pipeline. The credit-efficient way to run Explorador passes.

The agent only needs to:
1. Web-search to find a list of candidate URLs (light context)
2. Hand that list to this orchestrator (this script)
3. Read the final summary

This script handles:
- Fetching each URL via scrape_contacts.py (no HTML in LLM context)
- Aggregating contacts into a raw batch JSON in the vault
- Optionally running process_leads_batch.py to verify + dedupe + sort

Usage:
    scrape_orchestrator.py \\
        --urls-file urls.txt \\
        --batch-name texas-universities-procurement \\
        --institution-map map.json \\
        [--verify]

    urls.txt: one URL per line (blank lines and lines starting with # are ignored)
    map.json: optional JSON {url: {institution, country, type, contact_hint}}
              fills institution metadata; otherwise inferred from the domain
    --verify: invoke process_leads_batch.py inline after scraping

Output:
    Writes vault/leads/raw/batch-YYYY-MM-DD-<batch-name>.json
    Prints a JSON summary to stdout (operator/agent reads this — small footprint)
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

THIS_DIR = Path(__file__).parent
VAULT_RAW = Path("/opt/velab/vault/leads/raw")
SCRAPLING_PYTHON = "/opt/scrapling-venv/bin/python3"
SYSTEM_PYTHON = "/usr/bin/python3"
CRAWL4AI_PYTHON = "/opt/crawl4ai-venv/bin/python3"
CRAWL4AI_EXTRACT = THIS_DIR / "crawl4ai_extract.py"
# Tier-3 fallback: camoufox (anti-detect Firefox). Optional and gated on an
# explicit readiness marker — the venv + browser binary alone are NOT enough,
# Firefox also needs a GTK3 runtime + a recent libnss3 (NSS_3.101). The marker
# /opt/camoufox-venv/.ready is created ONLY after a successful smoke render, so a
# half-installed camoufox can never churn doomed browser launches on this host.
# To activate: install the system libs, run a real camoufox_extract.py render,
# then `touch /opt/camoufox-venv/.ready`.
CAMOUFOX_PYTHON = "/opt/camoufox-venv/bin/python3"
CAMOUFOX_EXTRACT = THIS_DIR / "camoufox_extract.py"
CAMOUFOX_READY = Path("/opt/camoufox-venv/.ready")


def _camoufox_ready():
    """Tier-3 is live ONLY if .ready exists AND contains a real smoke-render marker
    ('smoke-ok'). A bare `touch` (empty file) does NOT count — this prevents doomed
    browser launches on a host missing the Firefox binary / required NSS libs, which
    is exactly the hollow-.ready failure the 2026-06-08 audit found."""
    try:
        return CAMOUFOX_READY.exists() and CAMOUFOX_READY.read_text(encoding="utf-8").strip().lower().startswith("smoke-ok")
    except Exception:
        return False

# Generic role-inbox local parts in EN/ES/PT
ROLE_LOCALS = {
    "ventas", "sales", "info", "informacion", "información", "contacto", "contact", "contacta",
    "admin", "administracion", "administración", "compras", "procurement", "purchasing",
    "buyer", "buyers", "import", "imports", "export", "comercial", "general", "team",
    "marketing", "support", "soporte", "ayuda", "help", "rrhh", "hr", "gerencia",
    "atencion", "atención", "atendimento", "vendas", "comercial",
}


# Role-inbox local parts that are NOT buying-relevant. Operator rule 2026-05-29:
# a lead inbox must belong to a buying function (sales / commercial / purchasing /
# management / general). Marketing, press, HR, comms, and presidency inboxes are
# off-target for Velab outreach and are dropped even though they are valid role
# inboxes. Finance/treasury are intentionally NOT here — a treasurer can be the
# real buyer at schools/universities (see CONTACT_LINK_KEYWORDS in scrape_contacts).
NON_BUYER_LOCALS = {
    "marketing", "mercadeo", "prensa", "press", "comunicaciones", "comunicacion",
    "rrhh", "hr", "recursoshumanos", "talentohumano",
    "presidencia", "presidency", "webmaster", "social", "redes", "communitymanager",
}


def is_non_buyer_inbox(email):
    local = email.split("@")[0].lower()
    if local in NON_BUYER_LOCALS:
        return True
    for word in NON_BUYER_LOCALS:
        if local.startswith(word + ".") or local.startswith(word + "_") or local.startswith(word + "-"):
            return True
    return False


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def institution_from_domain(domain):
    # Name from the REGISTRABLE root's first label, not the raw subdomain — so
    # eng.example-university.edu -> "ExampleUniversity", not 'Mecanica' (2026-06-24 review fix).
    # Mirrors lead_guards.company_name_from_domain (kept inline: orchestrator loads
    # siblings via importlib, not a plain import).
    host = (domain or "").lower()
    if host.startswith("www."):
        host = host[4:]
    labels = host.split(".")
    if len(labels) <= 2:
        root = host
    elif len(labels[-1]) == 2 and labels[-2] in {
            "com", "co", "net", "org", "gob", "gov", "edu", "ac", "go", "or",
            "ind", "mil", "biz", "info"}:
        root = ".".join(labels[-3:])
    else:
        root = ".".join(labels[-2:])
    first = root.split(".")[0] if root else ""
    return first.capitalize() if first else (domain or "")


def is_role_inbox(email):
    local = email.split("@")[0].lower()
    if local in ROLE_LOCALS:
        return True
    for word in ROLE_LOCALS:
        if local.startswith(word + ".") or local.startswith(word + "_") or local.startswith(word + "-"):
            return True
    return False


def guess_name(local_part):
    # Only infer a name from a clear first.last / first_last / first-last pattern.
    # A single-token local (company names like "labomersa", role words like
    # "servicioalcliente", region tags like "antioquia") is NOT a confident
    # person name — leave it empty rather than invent one. The LLM enrichment
    # step fills real names from the page snippet; empty beats fabricated.
    if not re.search(r"[._\-]", local_part):
        return ""
    cleaned = re.sub(r"[._\-]+", " ", local_part).strip()
    # Require at least two tokens (first + last) and no digits.
    if " " not in cleaned or len(cleaned) < 3:
        return ""
    if any(c.isdigit() for c in cleaned):
        return ""
    return cleaned.title()


def run_subprocess(cmd, timeout):
    # start_new_session=True isolates the child in its OWN process group, so a
    # timeout can SIGKILL the entire tree. subprocess.run(timeout=) only kills the
    # direct child, leaving orphaned camoufox/chrome browsers pinning a CPU core
    # (the 26h incident, 2026-05-31). Kill the group, then reap.
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, start_new_session=True)
    try:
        out, err = proc.communicate(timeout=timeout)
        return subprocess.CompletedProcess(cmd, proc.returncode, out, err)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
        try:
            proc.communicate(timeout=10)
        except Exception:
            pass
        raise


def domain_resolves(domain: str) -> tuple[bool, str | None]:
    """Return (True, None) if the domain resolves; (False, reason) otherwise.

    Used as a pre-flight check before scrape_one. NXDOMAIN-dead URLs surfaced by
    search results (AI-hallucinated or expired registrations) waste a full
    Scrapling subprocess + retry chain otherwise.
    """
    import socket
    host = domain.split(":", 1)[0].strip()
    if not host:
        return False, "empty hostname"
    try:
        socket.getaddrinfo(host, None)
        return True, None
    except socket.gaierror as e:
        # e.errno: -2 = NXDOMAIN, -3 = EAI_AGAIN (temporary), -5 = no address
        if e.errno == -2:
            return False, "NXDOMAIN (domain does not exist)"
        if e.errno == -3:
            return False, "DNS server timeout (EAI_AGAIN) — domain may exist but resolver is unreachable"
        return False, f"DNS error: {e}"
    except Exception as e:
        return False, f"resolution failed: {e}"


def _run_extractor(python_bin, script, url, timeout):
    """Run one extractor subprocess and return (data, error) per the shared
    contract: data is the parsed JSON ({"contacts": [...], ...}) or None; error
    is a short string or None."""
    try:
        result = run_subprocess([python_bin, str(script), url], timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "timeout"

    if result.returncode != 0 and not result.stdout:
        return None, (result.stderr or "scrape failed")[:200]

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None, f"unparseable response from {script.name}"

    if "error" in data and not data.get("contacts"):
        return None, data["error"][:200]

    return data, None


# T2.8: bound the heavy headless render tiers (crawl4ai/camoufox). They already
# auto-escalate on a zero-email static result; cap how many domains per batch may
# escalate so a large pass cannot saturate CPU (complements the T1.1 watchdog).
_HEADLESS_USED = 0
HEADLESS_MAX = int(os.environ.get("RENDER_MAX_PER_BATCH", "40"))
RENDER_ON_EMPTY = os.environ.get("RENDER_ON_EMPTY", "1") != "0"


def scrape_one(url, timeout=120):
    """Primary: Scrapling. Token-light fallback: Crawl4AI.

    When Scrapling surfaces zero emails (JS-only shell, bot wall, SPA contact
    widget), retry once with Crawl4AI's real-Chromium render — that is exactly
    where role inboxes like ventas@/comercial@ tend to hide. The fallback is
    purely additive: it only fires on a zero-email/failed Scrapling result and
    is ignored if it, too, finds nothing. Both extractors share the contact
    schema, so downstream code is unchanged. Crawl4AI runs in its own venv."""
    global _HEADLESS_USED
    data, err = _run_extractor(SCRAPLING_PYTHON, THIS_DIR / "scrape_contacts.py", url, timeout)
    if data and data.get("contacts"):
        data["_tier"] = "scrapling"

    needs_render = err or not (data and data.get("contacts"))
    if needs_render and RENDER_ON_EMPTY and _HEADLESS_USED < HEADLESS_MAX:
        _HEADLESS_USED += 1
    elif needs_render:
        return data, err  # render gate closed or per-batch cap reached

    if (err or not (data and data.get("contacts"))) and CRAWL4AI_EXTRACT.exists():
        c_data, c_err = _run_extractor(CRAWL4AI_PYTHON, CRAWL4AI_EXTRACT, url, timeout)
        if c_data and c_data.get("contacts"):
            c_data["_tier"] = "crawl4ai"
            return c_data, None

    # Tier-3: camoufox (anti-detect Firefox). Fires only when Tiers 1+2 still surfaced
    # zero emails — the hard bot-walled / fingerprint-gated pages where a ventas@/comercial@
    # role inbox tends to hide. Gated on a real smoke-render marker (_camoufox_ready), NOT a
    # bare touch, so a half-installed camoufox can never churn doomed launches.
    if (err or not (data and data.get("contacts"))) and CAMOUFOX_EXTRACT.exists() and _camoufox_ready():
        m_data, m_err = _run_extractor(CAMOUFOX_PYTHON, CAMOUFOX_EXTRACT, url, timeout)
        if m_data and m_data.get("contacts"):
            m_data["_tier"] = "camoufox"
            return m_data, None

    return data, err


def scrape_cluster(primary_url, max_subpaths=5):
    """Fetch the primary URL, then follow up to `max_subpaths` of its detected
    contact/about/team/procurement links. Returns:
        (aggregated_contacts, subpath_outcomes, primary_data, primary_error)

    aggregated_contacts: list of contacts dicts, deduped by email, with the
        richest snippet across the cluster preserved. Each entry carries
        `_from_subpath` (the subpath URL where it was found, or "" for primary)
        and `_subpath_keyword` (the keyword that surfaced that subpath).
    subpath_outcomes: list of {"url","keyword","status"} for telemetry.
    primary_data, primary_error: the underlying scrape_one() return for the
        primary URL (so the orchestrator can keep its existing failure handling).
    """
    primary_data, primary_err = scrape_one(primary_url, timeout=120)
    subpath_outcomes = []

    if primary_err or not primary_data:
        return [], subpath_outcomes, primary_data, primary_err

    # Email -> (contact dict, snippet length). Keep the longest snippet across
    # the cluster — that's the one most likely to carry name + title + phone.
    cluster = {}

    def absorb(contact, subpath_url, keyword, tier):
        em = contact.get("email")
        if not em:
            return
        snippet_len = len(contact.get("snippet") or "")
        existing = cluster.get(em)
        if existing is None or snippet_len > len(existing[0].get("snippet") or ""):
            enriched = dict(contact)
            enriched["_from_subpath"] = subpath_url
            enriched["_subpath_keyword"] = keyword
            enriched["_tier"] = tier  # which extractor surfaced this email
            cluster[em] = (enriched, snippet_len)

    for c in primary_data.get("contacts", []):
        absorb(c, "", "primary", primary_data.get("_tier", "scrapling"))

    # Fan out into the candidate subpaths
    candidate_links = (primary_data.get("contact_links") or [])[:max_subpaths]
    for cl in candidate_links:
        sub_url = cl.get("url")
        if not sub_url:
            continue
        sub_data, sub_err = scrape_one(sub_url, timeout=60)
        if sub_err:
            subpath_outcomes.append({"url": sub_url, "keyword": cl.get("keyword"), "status": f"error:{sub_err[:80]}"})
            continue
        contacts_here = sub_data.get("contacts", [])
        subpath_outcomes.append({
            "url": sub_url,
            "keyword": cl.get("keyword"),
            "status": f"ok:{len(contacts_here)}_contacts",
        })
        for c in contacts_here:
            absorb(c, sub_url, cl.get("keyword"), sub_data.get("_tier", "scrapling"))

    aggregated = [v[0] for v in cluster.values()]
    return aggregated, subpath_outcomes, primary_data, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--urls-file", required=True, help="Plain text file, one URL per line")
    parser.add_argument(
        "--batch-name",
        required=True,
        help="Slug for the batch file (e.g. 'texas-universities-procurement')",
    )
    parser.add_argument(
        "--institution-map",
        help="Optional JSON {url: {institution, country, type, contact_hint}}",
    )
    parser.add_argument(
        "--target-description",
        default="",
        help="Free-text description of the target market for the summary",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Run process_leads_batch.py inline after scraping",
    )
    parser.add_argument(
        "--max-urls",
        type=int,
        default=0,
        help="Cap the number of URLs processed (0 = no cap, for safety)",
    )
    parser.add_argument(
        "--skip-dns-check",
        action="store_true",
        help="Disable the pre-fetch DNS resolution check (use only if scraping internal/hosts-file domains)",
    )
    parser.add_argument(
        "--revisit-days",
        type=int,
        default=30,
        help="Skip URLs scraped within this many days (default 30). Set to 0 to disable the registry check.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Bypass the source-registry recency check (re-scrape even recently-scraped URLs)",
    )
    parser.add_argument(
        "--max-subpaths",
        type=int,
        default=5,
        help="Per primary URL, follow up to this many contact/about/team/procurement subpaths. "
             "Set to 0 to scrape only the primary URL (pre-2026-05-21 behavior).",
    )
    parser.add_argument(
        "--category",
        default="",
        help="Default ICP category stamped on every lead when the institution-map doesn't "
             "supply a per-URL type. /leadgen always passes this so leads are never unknown-category.",
    )
    parser.add_argument(
        "--country",
        default="",
        help="Default country stamped on every lead when the institution-map doesn't supply "
             "a per-URL country. /leadgen always passes this so leads are never unknown-geo.",
    )
    args = parser.parse_args()

    # --- Guard: --verify is only allowed under the sanctioned background driver. ---
    # A foreground `scrape_orchestrator.py --verify` runs the 600s verifier inline,
    # which the Velab gateway exec timeout (~120-300s) SIGTERMs before it can
    # write a verified pack — the exact failure that stalled lead generation.
    # lead_pass.py sets LEAD_PASS_DRIVER=1 when it spawns us detached (no timeout),
    # so verification must go through it. A raw scrape WITHOUT --verify is still
    # allowed directly (quick scrape you intend to enrich before a separate verify).
    if args.verify and os.environ.get("LEAD_PASS_DRIVER") != "1":
        sys.exit(
            "REFUSED: --verify must run via the background driver, not the foreground.\n"
            "Foreground verification exceeds the agent exec timeout and gets killed mid-run.\n"
            "Use:  lead_pass.py start --urls-file <F> --batch-name <N> --verify [...]\n"
            "then: lead_pass.py status --batch-name <N>   (poll until state == done)"
        )

    # Source registry (lightweight import-as-module so we can use the helpers)
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "source_registry", THIS_DIR / "source_registry.py"
    )
    sr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sr)
    registry = sr.load()

    urls_path = Path(args.urls_file)
    if not urls_path.exists():
        sys.exit(f"urls file not found: {urls_path}")

    raw_urls = [
        line.strip()
        for line in urls_path.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if args.max_urls > 0:
        raw_urls = raw_urls[: args.max_urls]

    inst_map = {}
    if args.institution_map:
        inst_map = json.loads(Path(args.institution_map).read_text())

    today = date.today().isoformat()
    leads = []
    failures = []
    dead_domains = []
    skipped_recent = []
    per_url_yield = {}  # url -> (emails_found, verified_emails) for registry recording
    seen_emails = set()
    non_buyer_dropped = []  # role inboxes dropped for being off-function (marketing/HR/etc.)

    for url in raw_urls:
        meta = inst_map.get(url, {})
        domain = urlparse(url).netloc or url
        institution = meta.get("institution") or institution_from_domain(domain)
        country = meta.get("country") or args.country
        inst_type = meta.get("type") or args.category
        contact_hint = meta.get("contact_hint", "")

        # Registry recency check — skip URLs scraped within --revisit-days
        if args.revisit_days > 0 and not args.force:
            recent, entry = sr.is_recently_scraped(registry, url, args.revisit_days)
            if recent:
                skipped_recent.append({
                    "url": url,
                    "last_scraped": entry["last_scraped"],
                    "scrape_count": entry["scrape_count"],
                    "verified_yield_history": entry.get("verified_emails_yielded_total", 0),
                    "reason": f"scraped {entry['last_scraped']} ({entry['scrape_count']}x); skipping per --revisit-days={args.revisit_days}",
                })
                continue

        if not args.skip_dns_check:
            ok, reason = domain_resolves(domain)
            if not ok:
                dead_domains.append({"url": url, "domain": domain, "reason": reason})
                failures.append({"url": url, "reason": reason, "dead_domain": True})
                sr.record_scrape(registry, url, category=inst_type, country=country,
                                 emails_found=0, verified_emails=0,
                                 discovered_via="orchestrator-pass", batch_id=args.batch_name,
                                 scrape_date=today, error=reason)
                continue

        aggregated, subpath_outcomes, _primary_data, err = scrape_cluster(
            url, max_subpaths=args.max_subpaths
        )
        if err:
            failures.append({"url": url, "reason": err})
            sr.record_scrape(registry, url, category=inst_type, country=country,
                             emails_found=0, verified_emails=0,
                             discovered_via="orchestrator-pass", batch_id=args.batch_name,
                             scrape_date=today, error=err)
            continue

        url_email_count = 0
        for c in aggregated:
            email = c["email"]
            if email in seen_emails:
                continue
            seen_emails.add(email)

            # Relevance gate: drop role inboxes that aren't a buying function
            # (marketing@/prensa@/rrhh@/presidencia@/...). Operator rule 2026-05-29.
            if is_non_buyer_inbox(email):
                non_buyer_dropped.append({"url": url, "email": email})
                continue

            local = email.split("@")[0]
            role = is_role_inbox(email)

            snippet = c.get("snippet", "")
            from_subpath = c.get("_from_subpath", "") or url
            lead = {
                "institution": institution,
                "institution_type": inst_type,
                "country": country,
                "contact_name": "" if role else guess_name(local),
                "title": "Role inbox" if role else "",
                "email": email,
                "phone": "",
                "source_url": url,
                "found_on_url": from_subpath,  # the actual page the email was on (homepage or subpath)
                "extracted_via": c.get("_tier", "scrapling"),  # which extractor tier surfaced it
                "scrape_date": today,
                "email_verified": False,
                "icp_match": True,
                "notes": (contact_hint + " | " if contact_hint else "") + snippet[:280],
                # Full snippet preserved for the agent-side enrichment step (read by
                # explorador between scrape and verify to populate contact_name/title/phone).
                # Stripped by process_leads_batch.py before promotion to verified.
                "_raw_snippet": snippet,
            }
            leads.append(lead)
            url_email_count += 1

        # Telemetry: surface subpath outcomes so the operator can see which
        # subpaths a domain exposes and which were dead-ends.
        if subpath_outcomes:
            per_url_yield.setdefault("_subpath_log", []).append({
                "primary": url,
                "subpaths": subpath_outcomes,
            })

        per_url_yield[url] = url_email_count
        # Record raw-scrape outcome now (verified count will be back-filled after process_leads_batch)
        sr.record_scrape(registry, url, category=inst_type, country=country,
                         emails_found=url_email_count, verified_emails=0,
                         discovered_via="orchestrator-pass", batch_id=args.batch_name,
                         scrape_date=today)

    # Write the batch JSON
    VAULT_RAW.mkdir(parents=True, exist_ok=True)
    batch_path = VAULT_RAW / f"batch-{today}-{slugify(args.batch_name)}.json"
    batch_path.write_text(json.dumps(leads, indent=2, ensure_ascii=False))

    summary = {
        "target_description": args.target_description,
        "urls_processed": len(raw_urls),
        "urls_succeeded": len(raw_urls) - len(failures) - len(skipped_recent),
        "urls_failed": len(failures),
        "urls_dead_domain": len(dead_domains),
        "urls_skipped_recent": len(skipped_recent),
        "contacts_extracted": len(leads),
        "unique_emails": len(seen_emails),
        "non_buyer_inboxes_dropped": len(non_buyer_dropped),
        "non_buyer_dropped": non_buyer_dropped[:20],
        "output_path": str(batch_path),
        "failures": failures[:20],  # cap to keep summary small
        "dead_domains": dead_domains[:20],
        "skipped_recent": skipped_recent[:20],
        "subpath_log": per_url_yield.get("_subpath_log", [])[:20],
    }

    # Persist the registry now even if verify path isn't taken
    sr.save(registry)

    if args.verify and leads:
        try:
            verify_result = run_subprocess(
                [SYSTEM_PYTHON, str(THIS_DIR / "process_leads_batch.py"), str(batch_path), "--pretty"],
                timeout=3600,
            )
            try:
                summary["verification"] = json.loads(verify_result.stdout)
                # Back-fill verified counts per URL into the source registry
                verified_path = (summary["verification"].get("verified_path")
                                 if isinstance(summary["verification"], dict) else None)
                if verified_path and Path(verified_path).exists():
                    try:
                        verified_rows = json.loads(Path(verified_path).read_text())
                        from collections import Counter
                        verified_by_url = Counter()
                        for r in verified_rows:
                            src = r.get("source_url")
                            if src:
                                verified_by_url[src] += 1
                        for src, count in verified_by_url.items():
                            entry = sr.get(registry, src)
                            if entry:
                                # Update the latest history event's verified_emails
                                if entry.get("history"):
                                    entry["history"][-1]["verified_emails"] = count
                                # Add to the running total (we recorded 0 earlier in this batch)
                                entry["verified_emails_yielded_total"] = entry.get("verified_emails_yielded_total", 0) + count
                        sr.save(registry)
                    except Exception:
                        pass
            except json.JSONDecodeError:
                summary["verification_error"] = (verify_result.stderr or "verify failed")[:500]
        except subprocess.TimeoutExpired:
            summary["verification_error"] = "verifier timed out (>3600s)"

    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
