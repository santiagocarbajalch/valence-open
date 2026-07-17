#!/usr/bin/env python3
import argparse
import os
import json
import subprocess
from pathlib import Path

try:
    from email_validator import validate_email, EmailNotValidError
except Exception:  # pragma: no cover
    validate_email = None
    EmailNotValidError = Exception

REACHER_URL = "http://localhost:8080/v0/check_email"
DATA_DIR = Path(__file__).resolve().parent / "data"
DISPOSABLE_FILE = DATA_DIR / "disposable_domains.txt"
FREE_FILE = DATA_DIR / "free_email_providers.txt"

# Operator-canonical DNC sources, read live from the shared Obsidian vault. Both honored.
VAULT = Path.home() / "velab" / "vault"
DNC_MD = VAULT / "reference" / "dnc-domains.md"
DNC_JSONL = VAULT / "suppression" / "dnc.jsonl"


def load_domain_set(path: Path):
    if not path.exists():
        return set()
    with path.open() as f:
        return {line.strip().lower() for line in f if line.strip() and not line.startswith("#")}


def load_dnc_domains():
    """Parse operator DNC domains from the vault: backticked domains under '## Active DNC'
    in dnc-domains.md + every 'domain' field in suppression/dnc.jsonl."""
    import re as _re
    dnc = set()
    if DNC_MD.exists():
        parts = DNC_MD.read_text(encoding="utf-8").split("## Active DNC", 1)
        if len(parts) > 1:
            body = parts[1].split("## Candidates", 1)[0]
            for m in _re.findall(r"`([a-z0-9.-]+\.[a-z]{2,})`", body, _re.IGNORECASE):
                dnc.add(m.strip().lower())
    if DNC_JSONL.exists():
        for line in DNC_JSONL.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                d = (json.loads(line).get("domain") or "").strip().lower()
            except Exception:
                d = ""
            if d:
                dnc.add(d)
    return dnc


# Buyer-relevant role inboxes — the proven LATAM-distributor buying channel. Trusted on
# unconfirmable (catch-all / greylisted) servers because the inbox is published on the
# institution's own page; a guessed PERSONAL address on the same server is NOT.
ROLE_LOCALS = {
    "info", "sales", "ventas", "ventas1", "contacto", "contact", "comercial",
    "gerencia", "administracion", "admin", "soporte", "atencion", "servicioalcliente",
    "mail", "correo", "hola", "hello", "asesor", "compras", "coordinacion",
    "distribuidores", "cotizaciones", "pedidos", "laboratorio",
}
_ROLE_PREFIXES = ("ventas", "comercial", "compras", "info", "contacto", "cotiza")


def is_role_local(local_part: str) -> bool:
    lp = (local_part or "").lower().strip()
    return lp in ROLE_LOCALS or lp.startswith(_ROLE_PREFIXES)


DISPOSABLE_DOMAINS = load_domain_set(DISPOSABLE_FILE)
FREE_EMAIL_PROVIDERS = load_domain_set(FREE_FILE)
DNC_DOMAINS = load_dnc_domains()


def reacher_alive(max_time=12):
    """Liveness preflight. Probe with a SYNTAX-INVALID address (no '@') so Reacher answers
    from its syntax check in milliseconds WITHOUT a remote SMTP handshake — which is exactly
    what hangs (our probe IP gets greylisted on gmail/some MX, taking 60s+). This tests
    'is Reacher responding', not 'can it reach gmail'. A batch aborts LOUDLY if this fails,
    instead of silently dumping every lead to deferred. Returns (ok, detail)."""
    probe = os.environ.get("RCH_PREFLIGHT_EMAIL", "reacher-liveness-probe")
    payload = json.dumps({"to_email": probe})
    try:
        res = subprocess.run(
            ["curl", "-s", "--connect-timeout", "4", "--max-time", str(max_time),
             "-X", "POST", "-H", "Content-Type: application/json", "-d", payload, REACHER_URL],
            capture_output=True, text=True,
        )
        if res.returncode != 0 or not res.stdout.strip():
            return False, f"reacher unreachable (curl rc={res.returncode}, timeout {max_time}s)"
        data = json.loads(res.stdout)
        return ("is_reachable" in data), data.get("is_reachable")
    except Exception as e:
        return False, f"reacher preflight error: {e}"

PLACEHOLDER_LOCALS = {
    "example", "ejemplo", "exemplo", "test", "sample", "demo",
    "your-email", "youremail", "your.email", "tu-email", "tuemail",
    "tucorreo", "tu-correo", "seuemail", "seu-email",
}


def normalize_email(email):
    if not email:
        return None
    email = str(email).strip()
    if validate_email is None:
        return email.lower()
    try:
        return validate_email(email, check_deliverability=False).normalized
    except EmailNotValidError:
        return email.lower()


def has_institutional_affiliation(lead):
    if not isinstance(lead, dict):
        return False

    for field in ["institution", "institution_type", "company", "organization"]:
        value = lead.get(field)
        if isinstance(value, str) and value.strip():
            return True

    source_url = lead.get("source_url", "")
    if isinstance(source_url, str) and source_url.strip():
        return True

    return False


def call_reacher(email):
    # T3.13: present a real SPF-aligned MAIL FROM + a resolvable HELO name. Reacher's
    # default probe (HELO localhost, empty MAIL FROM) is exactly what MENA/Gulf servers
    # greylist or reject. Probes never send DATA, so no mail leaves — identity hygiene only.
    payload = json.dumps({
        "to_email": email,
        "from_email": os.environ.get("RCH_FROM_EMAIL", "sender@example.com"),
        "hello_name": os.environ.get("RCH_HELLO_NAME", "mail.example.com"),
    })
    result = subprocess.run(
        [
            "curl",
            "-s",
            "--connect-timeout",
            "5",
            "--max-time",
            "75",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-d",
            payload,
            REACHER_URL,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def verify_single(email, lead=None):
    normalized_email = normalize_email(email)
    result = {
        "email": normalized_email or email,
        "domain": None,
        "institutional_affiliation": has_institutional_affiliation(lead or {}),
        "secondary_filters": {
            "is_disposable_domain": False,
            "is_free_provider": False,
            "free_provider_rejected": False,
        },
        "reacher": None,
        "verdict": "unknown",
        "reason": "",
        "flags": [],
    }

    if not normalized_email or "@" not in normalized_email:
        result.update(verdict="rejected", reason="invalid syntax")
        return result

    local_part, _, domain = normalized_email.partition("@")
    domain = domain.lower()
    if local_part.lower() in PLACEHOLDER_LOCALS:
        result.update(verdict="rejected", reason="placeholder local-part", flags=["placeholder"])
        result["domain"] = domain
        return result
    result["domain"] = domain

    # DNC gate (operator-canonical): reject before probing — never scrape/verify/handoff a
    # do-not-contact domain. Matches the domain or any subdomain of a listed entry.
    if any(domain == d or domain.endswith("." + d) for d in DNC_DOMAINS):
        result.update(verdict="rejected", reason="DNC-listed domain", flags=["dnc"])
        return result

    try:
        reacher = call_reacher(normalized_email)
    except Exception as e:
        result.update(verdict="inconclusive", reason=f"reacher error: {e}", flags=["retry_later"])
        return result

    result["reacher"] = reacher
    syntax_valid = bool(reacher.get("syntax", {}).get("is_valid_syntax"))
    if not syntax_valid and validate_email is not None:
        try:
            validate_email(normalized_email, check_deliverability=False)
            syntax_valid = True
        except EmailNotValidError:
            syntax_valid = False

    is_disposable = domain in DISPOSABLE_DOMAINS or bool(reacher.get("misc", {}).get("is_disposable"))
    is_free_provider = domain in FREE_EMAIL_PROVIDERS
    free_provider_rejected = is_free_provider and not result["institutional_affiliation"]

    result["secondary_filters"] = {
        "is_disposable_domain": is_disposable,
        "is_free_provider": is_free_provider,
        "free_provider_rejected": free_provider_rejected,
        "syntax_valid": syntax_valid,
    }

    if not syntax_valid:
        result.update(verdict="rejected", reason="invalid syntax")
        return result

    if is_disposable:
        result.update(verdict="rejected", reason="disposable domain")
        return result

    if free_provider_rejected:
        result.update(verdict="rejected", reason="free email provider without institutional affiliation")
        return result

    reachable = reacher.get("is_reachable")
    smtp = reacher.get("smtp", {})

    if reachable == "safe":
        result.update(verdict="verified", reason="reacher safe")
        return result

    if reachable == "invalid":
        result.update(verdict="rejected", reason="reacher invalid")
        return result

    if reachable == "unknown":
        # Relaxed carve-out (env RELAX_INCONCLUSIVE=1): MENA/Gulf mail servers commonly
        # greylist or refuse Reacher's SMTP probe, returning "unknown" even though the
        # domain MX accepts mail and the address is a real institutional role inbox.
        # When MX accepts mail + institutional affiliation + not disposable/free, promote
        # to verified with an explicit lower-confidence flag so curation can distinguish.
        mx_accepts = bool((reacher.get("mx") or {}).get("accepts_mail"))
        institutional = result["institutional_affiliation"]
        if (os.environ.get("RELAX_INCONCLUSIVE") == "1" and is_role_local(local_part)
                and institutional and mx_accepts and not is_disposable and not free_provider_rejected):
            result.update(
                verdict="verified",
                reason="relaxed-unknown-institutional-mx",
                flags=["accepted_relaxed_unknown"],
            )
            return result
        # T2.7 greylist taxonomy: a host whose MX ACCEPTS mail but whose RCPT we
        # could not confirm is almost always greylisting/transient-block — retryable
        # on a later pass (greylisting clears). A host with no MX-accept is genuinely
        # unknown. Tag distinctly so process_leads_batch can route to the deferred bucket.
        if mx_accepts:
            result.update(verdict="inconclusive",
                          reason="deferred-greylist (mx accepts mail; rcpt unconfirmed)",
                          flags=["deferred_greylist", "retry_later"])
        else:
            result.update(verdict="inconclusive", reason="reacher unknown", flags=["retry_later"])
        return result

    if reachable == "risky":
        mx_accepts = bool((reacher.get("mx") or {}).get("accepts_mail"))
        institutional = result["institutional_affiliation"]

        if smtp.get("is_catch_all"):
            # Catch-all institutional servers (common on shared/cPanel hosting used by LATAM
            # distributors) make Reacher return risky regardless of whether the inbox exists.
            # On a catch-all server EVERY address "accepts", so a guessed personal address is
            # unconfirmable and must NOT be auto-verified. A buyer ROLE inbox is different: it's
            # published on the institution's own page, so it near-certainly exists. Scope the
            # rescue to role inboxes only (operator bar: role inboxes yes, personal-on-catch-all no).
            if is_role_local(local_part) and institutional and mx_accepts and not is_disposable and not free_provider_rejected:
                result.update(
                    verdict="verified",
                    reason="catch-all-institutional-role-inbox",
                    flags=["accepted_catch_all"],
                )
            else:
                result.update(verdict="inconclusive", reason="risky catch-all (non-role / unconfirmable)", flags=["catch_all", "review_flag"])
        elif institutional and mx_accepts and not is_disposable and not free_provider_rejected:
            # Role inboxes (ventas@, info@, contacto@) at real institutional domains commonly
            # come back risky from Reacher even when MX accepts mail and SMTP connects. They
            # are the primary B2B procurement channel for LATAM/MENA distributors and many
            # small-to-mid institutions — accept them with an explicit reason flag rather
            # than dropping them into review_flag purgatory.
            result.update(
                verdict="verified",
                reason="risky-institutional-role-inbox",
                flags=["accepted_risky"],
            )
        else:
            result.update(verdict="inconclusive", reason="risky", flags=["review_flag"])
        return result

    result.update(verdict="inconclusive", reason=f"unhandled reachability: {reachable}", flags=["review_flag"])
    return result


def verify_batch(filepath):
    with open(filepath) as f:
        data = json.load(f)
    leads = data if isinstance(data, list) else [data]
    for lead in leads:
        vr = verify_single(lead.get("email"), lead)
        lead["email_verified"] = vr["verdict"] == "verified"
        lead["verification"] = vr
        if vr["verdict"] == "inconclusive":
            lead["review_flag"] = True
            if "catch_all" in vr.get("flags", []):
                lead["catch_all"] = True
    return leads


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Reacher-based email verification")
    p.add_argument("email", nargs="?")
    p.add_argument("--batch")
    p.add_argument("--preflight", action="store_true", help="Reacher liveness check; exit 0 if alive, 1 if down")
    p.add_argument("--pretty", action="store_true")
    a = p.parse_args()
    indent = 2 if a.pretty else None
    if a.preflight:
        ok, detail = reacher_alive()
        print(json.dumps({"reacher_alive": ok, "detail": detail}, indent=indent))
        raise SystemExit(0 if ok else 1)
    if a.batch:
        print(json.dumps(verify_batch(a.batch), indent=indent, ensure_ascii=False))
    elif a.email:
        print(json.dumps(verify_single(a.email), indent=indent, ensure_ascii=False))
    else:
        p.print_help()
