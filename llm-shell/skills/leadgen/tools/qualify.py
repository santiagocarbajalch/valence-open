#!/opt/scrapling-venv/bin/python3
"""qualify.py — buying-power qualification by SCALE & FOOTPRINT (operator bar: Major only).

The funnel verifies deliverability + ICP fit but had no read on whether a candidate is a
substantial buyer. Tiny one-page shops can't buy from Velab; we need established players.
Per operator (2026-06-09): qualify on SCALE & FOOTPRINT visible on the company's OWN site —
branches/sucursales, years in business, catalog breadth, marquee clients — keep only Major.

Token-light director/laborer split: Python fetches each candidate's homepage + about/locations
pages (reusing the scraper's fetch path) and extracts CLEAN, READABLE evidence — their own
self-description, CONTEXTUAL years ("desde 1998"), real address blocks with cities, catalog
link depth, client roster. The LLM reads the compact evidence (never raw HTML) and makes the
Major/Mid/Small call. (An earlier version scored noisy regex COUNTS and wrongly rated a tiny
shop Major — "cali" matched "calidad", junk numbers counted as phones. Evidence, not counts.)

Usage:
    qualify.py --candidates /tmp/<slug>-cand.json [--max-pages 4] [--pretty]
      candidates JSON = [{"url","title","snippet"}, ...]  (discovery new_candidates)
Output: JSON list of evidence digests to stdout.
"""
import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse, urljoin

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scrape_contacts as sc

ABOUT_PATHS = ["nosotros", "quienes-somos", "quienessomos", "empresa", "about", "about-us",
               "sucursales", "contacto", "clientes", "la-empresa", "nuestra-empresa"]

# Cities matched ONLY with word boundaries AND near an address marker (avoids "cali" in
# "calidad"). Cross-country list so the tool works beyond Bolivia.
CITIES = ["la paz", "santa cruz", "cochabamba", "sucre", "oruro", "potosi", "tarija",
          "el alto", "trinidad", "lima", "arequipa", "trujillo", "bogota", "medellin",
          "cali", "barranquilla", "quito", "guayaquil", "cuenca", "santiago", "buenos aires",
          "cordoba", "rosario", "asuncion", "montevideo", "panama", "guatemala", "caracas"]
CITY_RE = re.compile(r"\b(" + "|".join(re.escape(c) for c in CITIES) + r")\b")
ADDR_RE = re.compile(r"(?:calle|av\.?|avenida|jr\.?|jir[oó]n|zona|edificio|direcci[oó]n|"
                     r"sucursal|oficina|pasaje|carrera|cra\.?)\b", re.I)
# CONTEXTUAL years only — a year tied to founding/experience language, not any 4-digit number.
FOUND_RE = re.compile(r"(?:desde|fundad[ao]s?(?:\s+en)?|establecid[ao]s?\s+en|cread[ao]\s+en|"
                      r"since|opera(?:mos|ndo)?\s+desde)\s*(?:el\s+a[ñn]o\s+)?((?:19|20)\d{2})", re.I)
YEARS_RE = re.compile(r"(?:m[áa]s\s+de\s+)?(\d{1,3})\s*a[ñn]os\s*(?:de\s+)?"
                      r"(?:experiencia|trayectoria|en\s+el\s+mercado|sirviendo|brindando)", re.I)
SCALE_RE = re.compile(r"(l[íi]der(?:es)?|principal(?:es)?|m[áa]s\s+grande|empresa\s+l[íi]der|"
                      r"distribuidor\s+(?:autorizado|exclusivo|oficial)|representante\s+(?:autorizado|exclusivo|oficial)|"
                      r"m[áa]s\s+de\s+\d[\d.,]*\s*(?:clientes|productos|marcas|empresas)|"
                      r"presencia\s+nacional|cobertura\s+nacional|a\s+nivel\s+nacional)", re.I)


def _strip_html(html):
    """sc.body_text returns RAW HTML; strip scripts/styles/tags to real visible text."""
    html = re.sub(r"(?is)<(script|style|noscript|head)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?s)<[^>]+>", " ", html)
    html = re.sub(r"&[a-zA-Z#0-9]+;", " ", html)
    return re.sub(r"\s+", " ", html).strip()


def _txt(url):
    try:
        page, _ = sc.fetch(url, mode="auto")
        body = page.body
        if isinstance(body, bytes):
            body = body.decode("utf-8", errors="replace")
        body = body or ""
        return _strip_html(body), body
    except Exception:
        return "", ""


def _clean(t):
    return re.sub(r"\s+", " ", t).strip()


def profile(url, title="", snippet="", max_pages=4, include_text=False):
    host = urlparse(url).hostname or url
    home_text, home_html = _txt(url)
    texts, fetched = [home_text], 1
    # collect a few about/locations/clients pages
    links = []
    if home_html:
        try:
            links = [l.get("url") for l in sc.extract_contact_links(home_html, url, max_links=10) if l.get("url")]
        except Exception:
            links = []
    base = f"{urlparse(url).scheme or 'https'}://{host}"
    seen = {url.rstrip('/')}
    for cand in links + [urljoin(base + "/", p) for p in ABOUT_PATHS]:
        if fetched >= max_pages:
            break
        c = (cand or "").rstrip("/")
        if not c or c in seen or host not in (urlparse(c).hostname or ""):
            continue
        seen.add(c)
        t, _ = _txt(c)
        if t:
            texts.append(t); fetched += 1

    full = "\n".join(texts)
    low = full.lower()

    # --- footprint: cities that appear near an address marker (within ~50 chars) ---
    addr_cities = set()
    for m in ADDR_RE.finditer(low):
        window = low[m.start():m.start() + 80]
        cm = CITY_RE.search(window)
        if cm:
            addr_cities.add(cm.group(1))
    # also any explicit "sucursal <city>"
    for m in re.finditer(r"sucursal[a-z\s:.\-]{0,20}", low):
        cm = CITY_RE.search(low[m.start():m.start() + 40])
        if cm:
            addr_cities.add(cm.group(1))

    founding = FOUND_RE.search(full)
    founding_year = int(founding.group(1)) if founding else None
    yexp = YEARS_RE.search(full)
    years_exp = int(yexp.group(1)) if yexp else None
    scale_claims = sorted({_clean(m.group(0))[:60] for m in SCALE_RE.finditer(full)})[:6]

    # catalog depth: distinct internal product/brand links on the homepage
    cat_links = set()
    for href in re.findall(r'href=["\']([^"\']+)["\']', home_html or "", re.I):
        if re.search(r"/(producto|productos|product|marca|marcas|catalog|categor)", href, re.I):
            cat_links.add(href.split("?")[0].rstrip("/").lower())

    # about-text excerpt for the LLM to actually READ
    about = ""
    am = re.search(r"(qui[eé]nes\s+somos|sobre\s+nosotros|nuestra\s+empresa|la\s+empresa|about\s+us|nosotros)",
                   full, re.I)
    if am:
        about = _clean(full[am.start():am.start() + 600])

    # client roster sample
    clients = ""
    cm = re.search(r"(nuestros\s+clientes|clientes\s*:|empresas\s+que\s+conf[íi]an)", full, re.I)
    if cm:
        clients = _clean(full[cm.start():cm.start() + 300])

    # conservative prelim tier — EVIDENCE-gated, biased to NOT over-promote.
    strong = 0
    if len(addr_cities) >= 2: strong += 1            # multi-city footprint
    if founding_year and founding_year <= 2015: strong += 1
    if years_exp and years_exp >= 10: strong += 1
    if len(cat_links) >= 12: strong += 1             # deep catalog
    if scale_claims: strong += 1
    if clients: strong += 1
    thin = len(_clean(full)) < 1500                  # one-page / brochure site
    tier = "Major" if strong >= 3 and not thin else ("Mid" if strong >= 2 and not thin else "Small")

    out = {
        "url": url, "host": host, "title": title,
        "fetched_pages": fetched,
        "founding_year": founding_year,
        "years_experience": years_exp,
        "address_cities": sorted(addr_cities),
        "branch_count": len(addr_cities),
        "catalog_links": len(cat_links),
        "scale_claims": scale_claims,
        "client_roster_excerpt": clients[:200],
        "about_excerpt": about,
        "thin_site": thin,
        "prelim_tier": tier,
        "prelim_strong_signals": strong,
    }
    if include_text:
        # Full lowercased visible text — consumed by icp_classify.py's lexicon scorer
        # (the ICP-relevance gate). Capped so callers don't carry megabytes around.
        out["_fulltext"] = low[:60000]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--max-pages", type=int, default=4)
    ap.add_argument("--pretty", action="store_true")
    a = ap.parse_args()
    cands = json.loads(Path(a.candidates).read_text())
    out = []
    for c in cands:
        try:
            out.append(profile(c["url"], c.get("title", ""), c.get("snippet", ""), a.max_pages))
        except Exception as e:
            out.append({"url": c.get("url"), "error": str(e), "prelim_tier": "Small"})
    print(json.dumps(out, ensure_ascii=False, indent=2 if a.pretty else None))


if __name__ == "__main__":
    main()
