#!/opt/scrapling-venv/bin/python3
"""Deterministic single-page contact extractor.

Fetches a URL via Scrapling (auto-escalating Fetcher → PlayWrightFetcher → StealthyFetcher),
extracts every email address found on the page, and captures a ~400-char context snippet
around each one. Returns structured JSON.

The LLM never sees raw HTML — it only sees the extracted email + snippet. This is the
single biggest credit saver in Explorador's pipeline.

Usage:
    scrape_contacts.py <url> [--mode auto|fetcher|playwright|stealth] [--pretty]

Output (JSON to stdout):
    {
      "url": "https://...",
      "fetched_via": "fetcher | playwright | stealth",
      "page_title": "...",
      "contacts_found": N,
      "contacts": [
        {"email": "...", "domain": "...", "snippet": "<text around email>", "source_url": "..."}
      ]
    }
"""

import argparse
import json
import re
import sys
import unicodedata
from urllib.parse import urldefrag, urljoin, urlparse, unquote

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")

# Template/placeholder domains that ship in theme demo content (nombre@ejemplo.com).
PLACEHOLDER_EMAIL_DOMAINS = {
    "ejemplo.com", "example.com", "example.org", "example.net", "exemplo.com",
    "misitio.com", "mysite.com", "domain.com", "yourdomain.com", "tudominio.com",
    "email.com", "correo.com", "sentry.local",
}
_ASSET_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".woff", ".woff2", ".css", ".js")

# --- Email recovery: Cloudflare cfemail decode + text de-obfuscation -----------
# ~21% of real distributor domains hide their address from a plain regex: behind
# Cloudflare's data-cfemail hex blob, or written as "info [at] x [dot] cl". Both
# are deterministic to recover (no JS/AI). Inherited by every caller (orchestrator
# + agents) since extraction lives here.
CFEMAIL_RE = re.compile(r'data-cfemail="([0-9a-fA-F]{6,})"')
DEOBF_RE = re.compile(
    r'([A-Za-z0-9._%+\-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|\s+at\s+|'
    r'\[\s*arroba\s*\]|\(\s*arroba\s*\)|\s+arroba\s+)\s*'
    r'([A-Za-z0-9.\-]+?)\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\s+dot\s+|'
    r'\[\s*punto\s*\]|\(\s*punto\s*\)|\s+punto\s+)\s*([A-Za-z]{2,})', re.I)

def _decode_cfemail(hexstr):
    try:
        key = int(hexstr[:2], 16)
        return "".join(chr(int(hexstr[i:i+2], 16) ^ key) for i in range(2, len(hexstr), 2))
    except Exception:
        return ""

def _recover_hidden_emails(html_text):
    """Return {email_lower: method} recovered from Cloudflare cfemail blobs and
    [at]/[dot]/arroba/punto obfuscation, so the EMAIL_RE pass catches them and each
    can be tagged (T1.4) with how it was recovered."""
    out = {}
    for h in CFEMAIL_RE.findall(html_text):
        d = _decode_cfemail(h)
        if "@" in d and "." in d.split("@")[-1]:
            out.setdefault(d.lower(), "cfemail")
    for m in DEOBF_RE.finditer(html_text):
        e = ("%s@%s.%s" % (m.group(1), m.group(2), m.group(3))).lower()
        out.setdefault(e, "deobfuscated")
    return out

# Common contact-page paths to probe even when the homepage does not link them
# (the orchestrator follows contact_links; many sites bury the email on /contacto
# with no matching homepage anchor). EN / ES / PT.
COMMON_CONTACT_PATHS = [
    "contacto", "contactenos", "contactanos", "contact", "contact-us", "contactus",
    "quienes-somos", "nosotros", "about", "about-us", "empresa", "soporte",
    "contato", "fale-conosco",
]


# Substrings that mark a link as likely leading to a page where humans + their
# titles + their direct contact info appear. Multilingual (EN / ES / PT). Names
# of staff / procurement officers / treasurers don't live on homepages; they
# live behind these subpaths. Matched against href path + anchor text (accent
# stripped, lowercased).
CONTACT_LINK_KEYWORDS = [
    # contact pages
    "contact", "contacto", "contactenos", "contactanos", "contactanos",
    "contate", "contato", "fale-conosco", "fale_conosco",
    # about / company
    "about", "nosotros", "quienes-somos", "quiensomos", "sobre-nosotros",
    "sobre_nosotros", "empresa", "company",
    # team / staff
    "team", "equipo", "equipe", "nuestro-equipo", "nossa-equipe",
    "nuestra-gente", "staff", "personal", "pessoal", "plantilla",
    "director-y", "directory", "directorio", "diretorio", "staff-directory",
    # procurement / purchasing / treasurer / finance
    "treasurer", "tesoreria", "tesouraria",
    "purchasing", "purchase", "compras", "comprar", "adquisiciones",
    "procurement", "abastecimiento",
    "business-services", "administracion", "administracao",
    "finance", "finanzas", "financas",
    # commercial / sales / management
    "ventas", "sales", "vendas", "comercial",
    "gerencia", "gerentes", "management", "leadership", "liderazgo",
    "lideranca",
]

# Local parts that are obviously not real contacts
SKIP_LOCAL_PARTS = {
    "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon",
    "postmaster", "abuse", "webmaster",
    # Placeholders commonly left in WordPress/Wix/Joomla templates (EN/ES/PT)
    "example", "ejemplo", "exemplo", "test", "sample", "demo",
    "your-email", "youremail", "your.email", "tu-email", "tuemail",
    "tucorreo", "tu-correo", "seuemail", "seu-email",
}

# Domains that are placeholders
SKIP_DOMAINS = {
    "example.com", "example.org", "example.net", "domain.com", "yourdomain.com",
    "yourcompany.com", "company.com", "mysite.com", "email.com", "test.com",
    "sentry.io", "wixpress.com", "wix.com", "squarespace.com", "godaddy.com",
    "wordpress.com", "wordpress.org", "gravatar.com", "cloudflare.com",
    "jsdelivr.net", "googleapis.com", "gstatic.com", "schema.org", "w3.org",
    "sentry.wixpress.com", "no-reply.com", "noreply.com",
}


def fetch(url, mode="auto"):
    """Fetch a URL, auto-escalating through Scrapling tiers if needed.

    Scrapling 0.4.x exposes: Fetcher (HTTP), DynamicFetcher (Playwright-backed),
    StealthyFetcher (anti-bot bypass).
    """
    from scrapling import Fetcher, DynamicFetcher, StealthyFetcher

    if mode in ("auto", "fetcher"):
        try:
            page = Fetcher.get(url, timeout=15)
            if page and getattr(page, "status", None) == 200 and page.body and len(page.body) > 500:
                return page, "fetcher"
        except Exception:
            pass
        if mode == "fetcher":
            raise RuntimeError("fetcher returned empty / failed")

    if mode in ("auto", "dynamic", "playwright"):
        try:
            page = DynamicFetcher.fetch(url, timeout=30) if hasattr(DynamicFetcher, "fetch") else DynamicFetcher.get(url, timeout=30)
            if page and getattr(page, "status", None) == 200:
                return page, "dynamic"
        except Exception:
            pass
        if mode in ("dynamic", "playwright"):
            raise RuntimeError("dynamic fetcher failed")

    if mode in ("auto", "stealth"):
        try:
            page = StealthyFetcher.fetch(url, timeout=45, solve_cloudflare=True) if hasattr(StealthyFetcher, "fetch") else StealthyFetcher.get(url, timeout=45, solve_cloudflare=True)
            return page, "stealth"
        except Exception as e:
            if mode == "stealth":
                raise
            raise RuntimeError(f"all fetch tiers failed for {url}: {e}")

    raise RuntimeError(f"fetch failed for {url}")


def body_text(page):
    raw = page.body
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    return raw or ""


def extract_contacts(html_text, url):
    seen = set()
    contacts = []
    recovered = _recover_hidden_emails(html_text)
    base_len = len(html_text)
    if recovered:
        html_text = html_text + "\n<!--recovered-emails-->\n" + " ".join(recovered.keys())

    for match in EMAIL_RE.finditer(html_text):
        # URL-decode first so percent-encoded addresses (cot%69zaciones@...) are matched
        # and filtered in their real form instead of leaking as garbage.
        email = unquote(match.group(0)).lower()
        if email in seen:
            continue
        local, _, domain = email.partition("@")

        # T1.4 hardening: reject malformed / multi-@ / junk-shaped before accept
        if email.count("@") != 1 or ".." in email or email.startswith(".") \
           or local.endswith(".") or domain.startswith(".") or domain.endswith(".") or "." not in domain:
            continue
        if local in SKIP_LOCAL_PARTS:
            continue
        # Suffix-match so subdomains of a skip domain are caught too
        # (e.g. sentry-next.wixpress.com under wixpress.com).
        if any(domain == d or domain.endswith("." + d) for d in SKIP_DOMAINS):
            continue
        if domain in PLACEHOLDER_EMAIL_DOMAINS:
            continue
        # Skip image/asset look-alikes: an asset extension on the local OR domain side,
        # or a retina tag (@2x / @3x / @4x ... as in logo@4x-770x317.png).
        if any(local.endswith(e) for e in _ASSET_EXTS) or any(domain.endswith(e) for e in _ASSET_EXTS):
            continue
        if re.search(r"@\d+x", email):
            continue

        seen.add(email)
        method = recovered.get(email, "recovered") if match.start() >= base_len else "static"

        start = max(0, match.start() - 200)
        end = min(len(html_text), match.end() + 200)
        snippet = html_text[start:end]
        snippet = re.sub(r"<[^>]+>", " ", snippet)  # strip HTML tags
        snippet = re.sub(r"&[a-zA-Z]+;", " ", snippet)  # strip HTML entities (simple)
        snippet = re.sub(r"\s+", " ", snippet).strip()

        contacts.append({
            "email": email,
            "domain": domain,
            "snippet": snippet,
            "source_url": url,
            "method": method,
        })

    return contacts


def extract_title(html_text):
    match = re.search(r"<title[^>]*>([^<]+)</title>", html_text, re.I)
    return match.group(1).strip() if match else ""


def _strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def _registered_host(netloc):
    h = netloc.lower()
    if h.startswith("www."):
        h = h[4:]
    return h


ANCHOR_RE = re.compile(r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)


def extract_contact_links(html_text, base_url, max_links=8):
    """Find same-origin subpath links that look like they lead to contact/staff/procurement info.

    The homepage rarely lists a procurement officer by name. The pages behind these links do.
    Returns a small ranked list of {url, keyword, anchor} dicts, capped at max_links, dedup'd
    by URL.
    """
    base_parsed = urlparse(base_url)
    base_host = _registered_host(base_parsed.netloc)
    base_norm = base_url.rstrip("/")

    seen = set()
    results = []

    for m in ANCHOR_RE.finditer(html_text):
        href = m.group(1).strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
            continue

        absolute = urljoin(base_url, href)
        absolute, _ = urldefrag(absolute)
        if absolute.endswith("?"):
            absolute = absolute[:-1]

        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https"):
            continue
        if _registered_host(parsed.netloc) != base_host:
            continue
        if absolute.rstrip("/") == base_norm:
            continue
        if absolute in seen:
            continue

        anchor_text = re.sub(r"<[^>]+>", " ", m.group(2))
        anchor_text = re.sub(r"\s+", " ", anchor_text).strip()
        haystack = _strip_accents((parsed.path + " " + anchor_text).lower())

        for kw in CONTACT_LINK_KEYWORDS:
            if kw in haystack:
                seen.add(absolute)
                results.append({
                    "url": absolute,
                    "keyword": kw,
                    "anchor": anchor_text[:80],
                })
                break

        if len(results) >= max_links:
            break

    # Always probe common contact paths even if the homepage did not link them.
    # Real anchor links rank first (better signal); guessed paths fill the rest.
    existing = {urlparse(r["url"]).path.strip("/").lower() for r in results}
    for p in COMMON_CONTACT_PATHS:
        if len(results) >= max_links:
            break
        if p in existing:
            continue
        guess = urljoin(base_url, "/" + p)
        guess, _ = urldefrag(guess)
        if guess.rstrip("/") == base_norm or guess in seen:
            continue
        seen.add(guess)
        results.append({"url": guess, "keyword": "guessed:" + p, "anchor": ""})

    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="URL to scrape")
    parser.add_argument("--mode", default="auto", choices=["auto", "fetcher", "playwright", "stealth"])
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    out = {"url": args.url, "contacts": [], "contacts_found": 0}

    try:
        page, method = fetch(args.url, args.mode)
    except Exception as e:
        out["error"] = str(e)[:300]
        print(json.dumps(out, indent=2 if args.pretty else None, ensure_ascii=False))
        sys.exit(1)

    html = body_text(page)
    contacts = extract_contacts(html, args.url)

    out["fetched_via"] = method
    out["page_title"] = extract_title(html)
    out["page_size_bytes"] = len(html)
    out["contacts_found"] = len(contacts)
    out["contacts"] = contacts
    out["contact_links"] = extract_contact_links(html, args.url)

    print(json.dumps(out, indent=2 if args.pretty else None, ensure_ascii=False))


if __name__ == "__main__":
    main()
