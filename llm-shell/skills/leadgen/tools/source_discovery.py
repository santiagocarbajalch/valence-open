#!/opt/scrapling-venv/bin/python3
"""Find new lead sources Explorador hasn't scraped yet.

Pipeline:
  1. Resolve query templates for (category, country) from data/source_discovery_queries.json
  2. For each query, query the local SearXNG metasearch API (Bing/Brave/Mojeek/Qwant/DDG); DDG-HTML scrape is fallback only
  3. Extract all candidate URLs
  4. Filter against source_registry — exclude anything already in there
  5. De-dup, rank by occurrence count, return top N

Output is a small JSON object the LLM can read directly — no raw HTML reaches context.

Usage:
    source_discovery.py --category lab-equipment-distributor --country Peru --max 15
    source_discovery.py --category forensic-crime-lab --country Argentina --max 20
    source_discovery.py --list-categories                                # show available categories
"""

import argparse
import unicodedata
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse, quote_plus

THIS_DIR = Path(__file__).resolve().parent
DATA_PATH = THIS_DIR / "data" / "source_discovery_queries.json"
DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/?q={}"
# Primary backend: local SearXNG metasearch (docker, host-net, 127.0.0.1:8888).
# One query fans out across several independent indexes, so it surfaces ~3-6x more
# distinct small/mid distributor domains than the single-engine DDG scrape. Google
# is deliberately omitted from the engine list — it fingerprint-blocks SearXNG.
SEARXNG_URL = "http://127.0.0.1:8888/search"
SEARXNG_ENGINES = "google,yandex,bing,duckduckgo,brave,mojeek,qwant"
SEARXNG_PAGES = 3  # fetch pages 1..N and merge; pages 2-3 surface the long-tail
                  # distributors that page-1-only never reaches (audit: ~3x candidate surface)
TOOL_VERSION = "1.1.0"

EXCLUDE_DOMAINS = {
    "duckduckgo.com", "google.com", "bing.com", "yahoo.com",
    "youtube.com", "facebook.com", "twitter.com", "x.com", "linkedin.com",
    "instagram.com", "tiktok.com", "wikipedia.org", "wikimedia.org",
    "reddit.com", "quora.com", "amazon.com", "amazon.es", "amazon.com.ar",
    "ebay.com", "alibaba.com", "indeed.com",
    "pinterest.com", "issuu.com",
    # Reference/dictionary/encyclopedia junk that SearXNG's wider net pulls in —
    # a dictionary entry for "laboratory" otherwise passes the positive-token gate.
    "britannica.com", "merriam-webster.com", "dictionary.cambridge.org",
    "dictionary.com", "thefreedictionary.com", "collinsdictionary.com",
    "microbenotes.com", "wepa.com", "scribd.com", "slideshare.net", "researchgate.net",
    # Generic B2B aggregators / lead-registries that are not first-party distributors.
    "tradeindia.com", "indiamart.com", "exportersindia.com", "medicregister.com",
    "processregister.com", "globalsources.com", "made-in-china.com", "dnb.com",
}

# Deterministic ICP-relevance gate (0 tokens). SearXNG's multi-engine depth pulls
# more noise, so we require an on-ICP signal and drop wrong-geo vendors.
# A candidate must carry at least one of these tokens in host/title/snippet.
ICP_POSITIVE_TOKENS = {
    "lab", "labor", "quimic", "químic", "cientif", "científ", "reactiv", "equipo",
    "instrument", "microscop", "balanz", "centrifug", "espectro", "suminist",
    "distribu", "import", "scientific", "laboratory", "biolog", "diagnost", "analitic",
    "analític", "material de laboratorio", "insumo",
    # French (Morocco + francophone MENA distributor sites)
    "laboratoire", "materiel", "reactif", "equipement", "fournisseur",
    "distributeur", "scientifique", "verrerie", "analyse", "appareil",
}
# Wrong-geo vendor ccTLDs for a LATAM ICP (India/Pakistan/China/Bangladesh/Sri Lanka).
FOREIGN_VENDOR_TLDS = (".in", ".pk", ".cn", ".bd", ".lk", ".ng")
# Domain substrings that mark foreign exporters / import-data aggregators / portals
# that survive the keyword gate on a .com (e.g. labequipmentINDIA, eduscopeINDIA,
# eduCHINA, VOLZA/TRADEKEY import data, maharashtraDIRECTORY). NOT "import/export" —
# those appear in legit "importadora" LATAM distributor names.
NEG_DOMAIN_SUBSTRINGS = (
    "india", "china", "tariff", "tradekey", "tradehold", "tradeshow", "volza",
    "globalsources", "maharashtra", "directory", "exportersindia", "tradeindia",
    ".gov", ".edu", ".mil",
)
# Job boards / news / course / generic-listing domains that carry "laboratorio" in their
# title-snippet and so survive the positive-token gate, but are never first-party labs or
# distributors. (paginasamarillas/amarillas are intentionally NOT here — directories that
# link OUT to companies are valid seeds per the proven recipe.)
NOISE_DOMAIN_SUBSTRINGS = (
    "empleo", "computrabajo", "trabajando", "jobted", "jooble", "paylab", "laborum",
    "bumeran", "opcionempleo", "glassdoor", "indeed", "talent", "konzerta",
    "cursoauxiliar", "entusmanos", "telefonos", "prensa", "noticias", "gestion.pe",
    "wikipedia", "foursquare", "yelp", "scribd",
)


def load_queries() -> dict:
    return json.loads(DATA_PATH.read_text())


def load_registry():
    import importlib.util
    spec = importlib.util.spec_from_file_location("source_registry", THIS_DIR / "source_registry.py")
    sr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sr)
    return sr


def resolve_queries(spec: dict, category: str, country: str, region: str = "") -> list[tuple[str, str]]:
    """Returns [(query_text, lang), ...]."""
    cat_block = spec["categories"].get(category)
    if not cat_block:
        raise SystemExit(f"unknown category: {category}. Use --list-categories.")
    langs_by_country = cat_block.get("languages_by_country", {})
    lang = langs_by_country.get(country, langs_by_country.get("default", "en"))
    if lang == "BLOCKED":
        raise SystemExit(f"category '{category}' blocked for country '{country}' (parent-company territory or other policy)")
    out = []
    # Boost queries first so the [:max_queries] slice in discover() never drops
    # them — they are the highest-signal, ccTLD/city-targeted queries.
    for q, qlang in COUNTRY_QUERY_BOOST.get(country, []):
        out.append((q, qlang))
    # Lead with the COUNTRY'S language. English-first ordering starves LATAM markets when
    # --max-queries is small (Guatemala/Panama returned 0 because only the English queries
    # ran). Boost queries (city/ccTLD) still come first.
    primary = {"es": "queries_es", "pt": "queries_pt", "en": "queries_en"}.get(lang, "queries_en")
    ordered_fields = [primary] + [f for f in ("queries_es", "queries_pt", "queries_en") if f != primary]
    for lang_field in ordered_fields:
        for tmpl in cat_block.get(lang_field, []):
            q = tmpl.replace("{country}", country).replace("{region}", region or country)
            q = re.sub(r"\{[a-z_]+\}", "", q).strip()
            out.append((q, lang_field[-2:]))
    return out


def _unwrap_ddg_redirect(href: str) -> str:
    """DDG wraps every result in //duckduckgo.com/l/?uddg=<encoded-url>. Extract the real URL."""
    from urllib.parse import unquote, parse_qs
    if not href:
        return href
    # Protocol-relative URLs from DDG
    if href.startswith("//"):
        href = "https:" + href
    if "duckduckgo.com/l/" in href and "uddg=" in href:
        try:
            qp = parse_qs(urlparse(href).query)
            if "uddg" in qp:
                return unquote(qp["uddg"][0])
        except Exception:
            pass
    return href


def _fetch_searxng(query: str, timeout: int = 30, lang: str = "") -> list[dict]:
    """Query the local SearXNG JSON API across curated block-resistant engines.
    Returns [{url, title, snippet}, ...] or [] on any failure (caller falls back to
    the DDG HTML scrape). This is the depth multiplier: one query merges results
    from Bing/Brave/Mojeek/Qwant/DDG — independent indexes surface distinct distributor
    domains a single engine never returns. `lang` (es/pt/en) localizes the search so
    engines bias to in-country results — the single biggest lever against wrong-geo
    (India/China .com) vendor noise that English queries otherwise pull in."""
    import urllib.request
    import urllib.parse
    out = []
    seen = set()
    for pageno in range(1, SEARXNG_PAGES + 1):
        params = {"q": query, "format": "json", "engines": SEARXNG_ENGINES, "pageno": pageno}
        if lang in ("es", "pt", "en"):
            params["language"] = lang
        qs = urllib.parse.urlencode(params)
        req = urllib.request.Request(f"{SEARXNG_URL}?{qs}", headers={"User-Agent": "velab-discovery/1.2"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
        except Exception:
            break  # stop paginating on error; return what we have
        results = data.get("results", [])
        added = 0
        for r in results:
            href = r.get("url")
            if href and href not in seen:
                seen.add(href)
                out.append({"url": href, "title": (r.get("title") or "").strip(),
                            "snippet": (r.get("content") or "").strip(),
                            "engine": (r.get("engine") or (r.get("engines") or [None])[0] or "unknown")})
                added += 1
        if added == 0:  # page returned nothing new -> tail exhausted
            break
    return out


def fetch_results(query: str, timeout: int = 30, lang: str = "") -> list[dict]:
    """Primary: local SearXNG metasearch (multi-engine, localized by `lang`).
    Fallback: DuckDuckGo HTML scrape (the original single-engine path).
    Returns [{url, title, snippet}, ...]."""
    sx = _fetch_searxng(query, timeout, lang)
    if sx:
        return sx
    from scrapling import Fetcher, DynamicFetcher

    url = DUCKDUCKGO_URL.format(quote_plus(query))
    page = None
    for fetcher_name, call in (("fetcher", lambda: Fetcher.get(url, timeout=timeout, impersonate="chrome")),
                                ("dynamic", lambda: DynamicFetcher.fetch(url, timeout=timeout * 1000))):
        try:
            p = call()
            if p and getattr(p, "status", 0) == 200 and p.body:
                page = p
                break
        except Exception:
            continue
    if not page:
        return []
    results = []
    try:
        for r in page.css("div.result, div.web-result"):
            try:
                href = r.css("a.result__a::attr(href)").get() or r.css("a::attr(href)").get()
                title = r.css("a.result__a::text").get() or r.css("a::text").get()
                snippet = r.css("a.result__snippet::text").get() or r.css(".result__snippet::text").get()
                if href:
                    href = _unwrap_ddg_redirect(href.strip())
                    results.append({"url": href, "title": (title or "").strip(), "snippet": (snippet or "").strip()})
            except Exception:
                continue
    except Exception:
        pass
    return results


# Country geo-gate (0 tokens). At discovery we only have SearXNG title/snippet
# (the page is crawled later), so the gate works on host ccTLD + title/snippet text:
#   - host on the target country ccTLD -> accept (strongest signal)
#   - host on a *different* known ccTLD -> reject (wrong country)
#   - generic gTLD (.com/.net/.org/...) -> require an explicit in-country signal,
#     else reject. This is what stops global exporters / trade-data portals
#     (tendata.cn, pharma-test.de, uscopes.com, *export.com) from passing as
#     in-country distributors. Countries without a gate pass through unchanged.
COUNTRY_GATES = {
    "Chile":      {"cctld": ".cl", "signals": ("chile", "santiago", "+56", "regi\u00f3n metropolitana", "valpara\u00edso", "concepci\u00f3n", "antofagasta")},
    "Peru":       {"cctld": ".pe", "signals": ("per\u00fa", "peru", "lima", "+51", "arequipa", "callao", "trujillo")},
    "Argentina":  {"cctld": ".ar", "signals": ("argentina", "buenos aires", "+54", "c\u00f3rdoba", "rosario", "mendoza")},
    "Mexico":     {"cctld": ".mx", "signals": ("m\u00e9xico", "mexico", "cdmx", "+52", "guadalajara", "monterrey")},
    "Colombia":   {"cctld": ".co", "signals": ("colombia", "bogot\u00e1", "bogota", "+57", "medell\u00edn", "cali")},
    "Brazil":     {"cctld": ".br", "signals": ("brasil", "brazil", "s\u00e3o paulo", "sao paulo", "+55", "rio de janeiro")},
    "Costa Rica": {"cctld": ".cr", "signals": ("costa rica", "san jos\u00e9", "san jose", "+506")},
    "Ecuador":    {"cctld": ".ec", "signals": ("ecuador", "quito", "guayaquil", "+593")},
    "Bolivia":    {"cctld": ".bo", "signals": ("bolivia", "la paz", "santa cruz", "+591")},
    "Uruguay":    {"cctld": ".uy", "signals": ("uruguay", "montevideo", "+598")},
    "Panama":             {"cctld": ".pa", "signals": ("panama", "+507", "ciudad de panama", "rep. de panama", "republica de panama", "colon")},
    "Dominican Republic": {"cctld": ".do", "signals": ("republica dominicana", "dominicana", "santo domingo", "santiago de los caballeros", "+1 809", "+1809", "809-", "829-", "849-", "rep. dom")},
    "Morocco":            {"cctld": ".ma", "signals": ("maroc", "morocco", "marruecos", "casablanca", "rabat", "marrakech", "tanger", "fes", "agadir", "+212", "00212")},
    "Jordan":             {"cctld": ".jo", "signals": ("jordan", "amman", "irbid", "zarqa", "aqaba", "+962", "00962")},
    "Bahrain":            {"cctld": ".bh", "signals": ("bahrain", "bahrein", "manama", "riffa", "muharraq", "sitra", "+973", "00973")},
    "United Arab Emirates": {"cctld": ".ae", "signals": ("uae", "u.a.e", "united arab emirates", "dubai", "abu dhabi", "sharjah", "ajman", "ras al khaimah", "+971", "00971")},
    "Saudi Arabia":        {"cctld": ".sa", "signals": ("saudi", "ksa", "k.s.a", "saudi arabia", "riyadh", "jeddah", "jiddah", "dammam", "khobar", "+966", "00966")},
    "Egypt":               {"cctld": ".eg", "signals": ("egypt", "egyptian", "cairo", "alexandria", "giza", "+20 ", "0020")},
    # ── ICP EXPANSION (operator) — new sanctioned frontiers ──────────
    # Rest-of-LatAm fill (same proven recipe, Mexico still excluded):
    "Guatemala":  {"cctld": ".gt", "signals": ("guatemala", "ciudad de guatemala", "quetzaltenango", "+502", "00502")},
    "Honduras":   {"cctld": ".hn", "signals": ("honduras", "tegucigalpa", "san pedro sula", "+504", "00504")},
    "El Salvador":{"cctld": ".sv", "signals": ("el salvador", "san salvador", "santa ana", "+503", "00503")},
    "Nicaragua":  {"cctld": ".ni", "signals": ("nicaragua", "managua", "leon", "+505", "00505")},
    "Paraguay":   {"cctld": ".py", "signals": ("paraguay", "asuncion", "ciudad del este", "+595", "00595")},
    "Venezuela":  {"cctld": ".ve", "signals": ("venezuela", "caracas", "maracaibo", "valencia", "+58", "0058")},
    # SE Asia (Philippines proven 2026-06-18 — 14 leads, fit 83-97):
    "Philippines":{"cctld": ".ph", "signals": ("philippines", "filipino", "manila", "quezon city", "cebu", "makati", "davao", "+63", "0063")},
    "Indonesia":  {"cctld": ".id", "signals": ("indonesia", "jakarta", "surabaya", "bandung", "bekasi", "+62", "0062")},
    "Malaysia":   {"cctld": ".my", "signals": ("malaysia", "kuala lumpur", "selangor", "penang", "johor", "+60", "0060")},
    "Vietnam":    {"cctld": ".vn", "signals": ("vietnam", "viet nam", "hanoi", "ho chi minh", "saigon", "da nang", "+84", "0084")},
    "Thailand":   {"cctld": ".th", "signals": ("thailand", "bangkok", "nonthaburi", "chiang mai", "+66", "0066")},
    # Sub-Saharan Africa (South Africa tested):
    "South Africa":{"cctld": ".za", "signals": ("south africa", "johannesburg", "cape town", "durban", "pretoria", "gauteng", "+27", "0027")},
    "Kenya":      {"cctld": ".ke", "signals": ("kenya", "nairobi", "mombasa", "kisumu", "+254", "00254")},
    "Nigeria":    {"cctld": ".ng", "signals": ("nigeria", "lagos", "abuja", "port harcourt", "ibadan", "+234", "00234")},
    "Ghana":      {"cctld": ".gh", "signals": ("ghana", "accra", "kumasi", "tema", "+233", "00233")},
}
# Per-country targeted query boost. The generic en/es/pt templates surface global
# noise for non-LATAM markets (MENA returned nature.com/labcorp for every country).
# These ccTLD- and capital-city-targeted queries localize the search to real
# in-country distributors. (query, searxng_lang).
COUNTRY_QUERY_BOOST = {
    "Colombia": [
        ("distribuidor equipos de laboratorio Bogota Colombia", "es"),
        ("importador material de laboratorio Medellin Cali", "es"),
        ("proveedor instrumentos cientificos Colombia contacto", "es"),
        ("casa comercial equipos laboratorio Barranquilla Colombia", "es"),
        ("distribuidor reactivos quimicos laboratorio Colombia", "es"),
        ("venta microscopios balanzas Colombia", "es"),
        ("suministros laboratorio clinico Colombia", "es"),
        ("equipos laboratorio Bucaramanga Pereira Colombia", "es"),
    ],
    "Ecuador": [
        ("distribuidor equipos de laboratorio Quito Ecuador", "es"),
        ("importador material de laboratorio Guayaquil Ecuador", "es"),
        ("proveedor instrumentos cientificos Ecuador contacto", "es"),
        ("casa comercial equipos laboratorio Cuenca Ecuador", "es"),
        ("distribuidor reactivos quimicos laboratorio Ecuador", "es"),
        ("venta microscopios balanzas Ecuador", "es"),
        ("suministros laboratorio clinico Ecuador Quito Guayaquil", "es"),
        ("equipos medicos y de laboratorio Ecuador", "es"),
    ],
    "Panama": [
        ("distribuidor equipos de laboratorio Panama site:.pa", "es"),
        ("casa comercial equipos laboratorio Ciudad de Panama", "es"),
        ("importador material de laboratorio Panama contacto", "es"),
        ("suministros laboratorio clinico Panama", "es"),
        ("distribuidor reactivos quimicos Panama site:.pa", "es"),
        ("venta microscopios balanzas Panama", "es"),
        ("proveedor instrumentos cientificos Panama contacto", "es"),
        ("equipos medicos y de laboratorio Panama", "es"),
    ],
    "Dominican Republic": [
        ("distribuidor equipos de laboratorio Republica Dominicana site:.do", "es"),
        ("suministros de laboratorio Santo Domingo", "es"),
        ("importador equipos cientificos Republica Dominicana contacto", "es"),
        ("distribuidor equipos laboratorio Santiago Republica Dominicana", "es"),
        ("suministros laboratorio clinico Republica Dominicana", "es"),
        ("importadora reactivos laboratorio Republica Dominicana", "es"),
        ("equipos medicos y de laboratorio Republica Dominicana site:.do", "es"),
        ("casa comercial laboratorio Santo Domingo contacto", "es"),
        ("venta microscopios balanzas Republica Dominicana", "es"),
        ("distribuidor instrumentos cientificos Republica Dominicana", "es"),
        ("proveedor material de laboratorio Republica Dominicana", "es"),
    ],
    "Morocco": [
        ("fournisseur materiel de laboratoire Maroc", "fr"),
        ("distributeur equipement scientifique Maroc site:.ma", "fr"),
        ("materiel de laboratoire Casablanca fournisseur", "fr"),
        ("distributeur reactifs laboratoire Maroc", "fr"),
        ("fournisseur verrerie laboratoire Maroc", "fr"),
        ("laboratory equipment supplier Morocco site:.ma", "en"),
        ("distributeur microscopes balances laboratoire Maroc", "fr"),
        ("equipement laboratoire Rabat Casablanca contact", "fr"),
    ],
    "Jordan": [
        ("laboratory equipment supplier Jordan site:.jo", "en"),
        ("lab equipment supplier Amman Jordan contact", "en"),
        ("scientific instruments distributor Jordan", "en"),
        ("laboratory supplies company Amman", "en"),
        ("medical laboratory equipment distributor Jordan site:.jo", "en"),
        ("scientific equipment trading Amman Jordan", "en"),
        ("laboratory chemicals reagents supplier Jordan", "en"),
        ("lab supplies trading establishment Amman", "en"),
        ("scientific and medical equipment company Jordan", "en"),
        ("laboratory instruments dealer Irbid Zarqa Jordan", "en"),
        ("diagnostic laboratory equipment supplier Jordan", "en"),
        ("laboratory furniture fume hood supplier Jordan", "en"),
        ("biotechnology lab supplies company Jordan Amman", "en"),
        ("analytical instruments supplier Jordan contact", "en"),
        ("Jordan scientific trading co laboratory equipment", "en"),
        ("microscope balance centrifuge supplier Amman Jordan", "en"),
    ],
    "Bahrain": [
        ("laboratory equipment supplier Bahrain site:.bh", "en"),
        ("lab equipment supplier Manama Bahrain contact", "en"),
        ("scientific instruments distributor Bahrain", "en"),
        ("laboratory supplies company Manama", "en"),
        ("medical laboratory equipment Bahrain site:.bh", "en"),
        ("scientific equipment trading Manama Bahrain", "en"),
        ("laboratory chemicals reagents supplier Bahrain", "en"),
        ("lab supplies trading establishment Manama Riffa", "en"),
        ("scientific and medical equipment company Bahrain", "en"),
        ("laboratory instruments dealer Bahrain contact", "en"),
        ("diagnostic laboratory equipment supplier Bahrain", "en"),
        ("laboratory furniture fume hood supplier Bahrain", "en"),
        ("biotechnology lab supplies company Bahrain Manama", "en"),
        ("analytical instruments supplier Bahrain contact", "en"),
        ("Bahrain scientific trading co laboratory equipment", "en"),
        ("microscope balance centrifuge supplier Manama Bahrain", "en"),
    ],
    "United Arab Emirates": [
        ("laboratory equipment supplier UAE site:.ae", "en"),
        ("lab equipment supplier Dubai contact", "en"),
        ("scientific instruments distributor Abu Dhabi", "en"),
        ("laboratory supplies trading company Dubai Sharjah", "en"),
        ("medical and laboratory equipment trading LLC UAE", "en"),
        ("analytical instruments dealer UAE Dubai", "en"),
        ("lab consumables reagents supplier UAE", "en"),
        ("scientific equipment trading establishment Dubai", "en"),
        ("laboratory furniture fume hood supplier UAE", "en"),
        ("microscope balance centrifuge supplier Dubai UAE", "en"),
    ],
    "Saudi Arabia": [
        ("laboratory equipment supplier Saudi Arabia site:.sa", "en"),
        ("lab equipment supplier Riyadh contact", "en"),
        ("scientific instruments distributor Jeddah", "en"),
        ("laboratory supplies trading company Riyadh Dammam", "en"),
        ("medical and laboratory equipment trading Saudi Arabia", "en"),
        ("analytical instruments dealer Saudi Arabia Riyadh", "en"),
        ("lab consumables reagents supplier KSA", "en"),
        ("scientific equipment establishment Jeddah Saudi", "en"),
        ("laboratory furniture fume hood supplier Saudi Arabia", "en"),
        ("microscope balance centrifuge supplier Riyadh Saudi", "en"),
    ],
    "Egypt": [
        ("laboratory equipment supplier Egypt site:.eg", "en"),
        ("lab equipment supplier Cairo contact", "en"),
        ("scientific instruments distributor Egypt Cairo", "en"),
        ("laboratory supplies company Alexandria Egypt", "en"),
        ("medical and laboratory equipment import Egypt", "en"),
        ("analytical instruments dealer Egypt Cairo", "en"),
        ("lab consumables reagents supplier Egypt", "en"),
        ("scientific equipment trading Cairo Egypt", "en"),
        ("laboratory furniture fume hood supplier Egypt", "en"),
        ("microscope balance centrifuge supplier Cairo Egypt", "en"),
    ],
}

# ── Growable boost overlay (Jardinero gardener agent) ─────────────────────────
# The dict above is the AUTHORED baseline. Operator/Jardinero-grown boosts live in
# data/country_query_boost.json and are merged ON TOP here (additive + deduped), so
# the gardener only ever writes a data file — never this module. Format:
#   {"Jordan": [["laboratory equipment supplier Amman site:.jo", "en"], ...], ...}
def _load_boost_overlay():
    try:
        _p = DATA_PATH.parent / "country_query_boost.json"
        _d = json.loads(_p.read_text())
        return _d if isinstance(_d, dict) else {}
    except Exception:
        return {}

for _country, _qs in _load_boost_overlay().items():
    if _country.startswith("_"):
        continue  # skip _meta and other non-country keys
    _base = COUNTRY_QUERY_BOOST.setdefault(_country, [])
    _seen = {tuple(x) for x in _base}
    for _q in (_qs or []):
        _t = tuple(_q)
        if len(_t) == 2 and _t not in _seen:
            _base.append((_t[0], _t[1]))
            _seen.add(_t)


# Known ccTLDs used to reject "wrong country" hosts. A host on one of these that
# isn't the target country's ccTLD is dropped before the signal check.
OTHER_CCTLDS = (
    ".cl", ".pe", ".ar", ".mx", ".co", ".br", ".cr", ".bo", ".ec", ".uy", ".py",
    ".ve", ".gt", ".pa", ".do", ".hn", ".sv", ".ni",
    ".de", ".es", ".it", ".fr", ".uk", ".in", ".pk", ".cn", ".bd", ".lk", ".ng",
    ".ma", ".jo", ".bh", ".ae", ".sa", ".qa", ".kw", ".om", ".eg", ".tn", ".dz",
    ".lb", ".il", ".tr", ".iq", ".sy", ".ye",
    # ICP expansion 2026-06-21 — SE Asia + Sub-Saharan Africa ccTLDs:
    ".ph", ".id", ".my", ".vn", ".th", ".za", ".ke", ".gh",
)


def passes_geo(url: str, title: str, snippet: str, country: str) -> bool:
    """Country geo-gate. See COUNTRY_GATES. Returns True (pass) for countries
    without a configured gate so existing categories are unaffected."""
    gate = COUNTRY_GATES.get(country)
    if not gate:
        return True
    host = (urlparse(url).hostname or "").lower()
    if host.endswith(gate["cctld"]):
        return True
    for cc in OTHER_CCTLDS:
        if cc != gate["cctld"] and host.endswith(cc):
            return False
    blob = _strip_accents(f"{host} {title} {snippet}".lower())
    return any(_strip_accents(sig) in blob for sig in gate["signals"])


def normalize_root(url: str) -> str | None:
    p = urlparse(url)
    if not p.scheme or not p.hostname:
        return None
    host = p.hostname.lower()
    if host.startswith("www."):
        host = host[4:]
    if any(host == d or host.endswith("." + d) for d in EXCLUDE_DOMAINS):
        return None
    return f"https://{host}/"


def _strip_accents(s: str) -> str:
    """Fold diacritics so 'espectr\u00f3metros' matches the token 'espectro' and
    'qu\u00edmico' matches 'quimic'. Prevents legit LATAM .cl/.pe domains whose
    pages use proper Spanish accents from being silently dropped by the ICP gate."""
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def passes_icp(url: str, title: str, snippet: str) -> bool:
    """Deterministic relevance gate (0 tokens). Drops wrong-geo vendors and requires
    at least one on-ICP token in host/title/snippet. EXCLUDE_DOMAINS (incl. reference
    junk) is already applied in normalize_root; this is the second, semantic filter
    that converts SearXNG's wider-but-noisier net into usable on-ICP candidates."""
    host = (urlparse(url).hostname or "").lower()
    if host.endswith(FOREIGN_VENDOR_TLDS):
        return False
    if any(s in host for s in NEG_DOMAIN_SUBSTRINGS):
        return False
    if any(s in host for s in NOISE_DOMAIN_SUBSTRINGS):
        return False
    blob = _strip_accents(f"{host} {title} {snippet}".lower())
    return any(_strip_accents(tok) in blob for tok in ICP_POSITIVE_TOKENS)


def already_in_registry(sr, registry: dict, url: str) -> bool:
    if sr.get(registry, url):
        return True
    # Also check the bare-root variant — if any sub-page of this domain is in registry, skip the domain
    host = urlparse(url).hostname or ""
    if not host:
        return False
    host_norm = host.lower().lstrip("www.")
    for key in registry["sources"].keys():
        kh = urlparse(key).hostname or ""
        if kh and (kh.lower().lstrip("www.") == host_norm):
            return True
    return False


def _query_channel(q):
    """T1.5: classify a query into a discovery channel for provenance stats."""
    ql = (q or "").lower()
    if "site:" in ql: return "site-operator"
    if any(w in ql for w in ("autorizad", "authorized", "distribuidor", "distributor")): return "distributor"
    if any(w in ql for w in ("importador", "importer", "representante", "representative")): return "importer"
    if any(w in ql for w in ("donde comprar", "where to buy")): return "where-to-buy"
    if any(w in ql for w in ("secop", "tender", "licitac", "contrat")): return "tender"
    return "generic"


def discover(category: str, country: str, region: str, max_candidates: int = 15,
             max_queries: int = 8, per_query_timeout: int = 30, throttle_s: float = 2.0,
             dry_run: bool = False) -> dict:
    spec = load_queries()
    sr = load_registry()
    registry = sr.load()

    queries = resolve_queries(spec, category, country, region)[:max_queries]
    occurrences = Counter()
    candidates_by_url = {}
    raw_count = 0
    off_icp_dropped = 0
    off_geo_dropped = 0
    off_icp_dropped_samples = []
    off_geo_dropped_samples = []
    queries_used = []

    for query, lang in queries:
        if dry_run:
            continue
        results = fetch_results(query, per_query_timeout, lang=lang)
        raw_count += len(results)
        for r in results:
            root = normalize_root(r["url"])
            if not root:
                continue
            if not passes_icp(root, r.get("title", ""), r.get("snippet", "")):
                off_icp_dropped += 1
                if len(off_icp_dropped_samples) < 80:
                    off_icp_dropped_samples.append({"url": root, "title": r.get("title", "")[:90], "snippet": r.get("snippet", "")[:120]})
                continue
            if not passes_geo(root, r.get("title", ""), r.get("snippet", ""), country):
                off_geo_dropped += 1
                if len(off_geo_dropped_samples) < 80:
                    off_geo_dropped_samples.append({"url": root, "title": r.get("title", "")[:90], "snippet": r.get("snippet", "")[:120]})
                continue
            occurrences[root] += 1
            if root not in candidates_by_url:
                candidates_by_url[root] = {"first_seen_in_query": query, "first_seen_lang": lang,
                                            "title": r.get("title", ""), "snippet": r.get("snippet", ""),
                                            "engine": r.get("engine", "unknown"), "channel": _query_channel(query)}
        queries_used.append({"query": query, "lang": lang, "results": len(results)})
        time.sleep(throttle_s)

    # Filter out anything already in the registry
    filtered = []
    skipped_known = 0
    for url, count in occurrences.most_common():
        if already_in_registry(sr, registry, url):
            skipped_known += 1
            continue
        meta = candidates_by_url[url]
        filtered.append({
            "url": url,
            "occurrences_across_queries": count,
            "first_seen_in_query": meta["first_seen_in_query"],
            "lang": meta["first_seen_lang"],
            "title": meta["title"][:120],
            "snippet": meta["snippet"][:200],
            "source_engine": meta.get("engine", "unknown"),
            "source_channel": meta.get("channel", "generic"),
        })
        if len(filtered) >= max_candidates:
            break

    # Log queries used into the registry
    if not dry_run:
        for q in queries_used:
            sr.record_query(registry, q["query"], category, country, results_promoted=0)
        sr.save(registry)
        # T1.5 provenance: append per-run engine/channel yield so discovery tuning
        # is measurable (which engine/channel actually finds candidates per country).
        try:
            by_engine = Counter(f.get("source_engine", "unknown") for f in filtered)
            by_channel = Counter(f.get("source_channel", "generic") for f in filtered)
            stats_path = Path("/opt/velab/vault/leads/discovery-stats.jsonl")
            stats_path.parent.mkdir(parents=True, exist_ok=True)
            with stats_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "category": category, "country": country,
                    "raw_results": raw_count, "new_candidates": len(filtered),
                    "by_engine": dict(by_engine), "by_channel": dict(by_channel),
                }, ensure_ascii=False) + "\n")
        except Exception:
            pass

    return {
        "category": category,
        "country": country,
        "region": region,
        "queries_attempted": len(queries),
        "raw_results": raw_count,
        "off_icp_dropped": off_icp_dropped,
        "off_geo_dropped": off_geo_dropped,
        "off_icp_dropped_samples": off_icp_dropped_samples,
        "off_geo_dropped_samples": off_geo_dropped_samples,
        "candidates_after_dedup": len(occurrences),
        "filtered_known_in_registry": skipped_known,
        "new_candidates": filtered,
        "queries_used": queries_used,
        "tool_version": TOOL_VERSION,
    }


def list_categories() -> dict:
    spec = load_queries()
    out = []
    for key, block in spec["categories"].items():
        out.append({"key": key, "label": block.get("label", key),
                    "languages": sorted(set(block.get("languages_by_country", {"default": "en"}).values()))})
    return {"categories": out, "total": len(out)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--category")
    parser.add_argument("--country", default="")
    parser.add_argument("--region", default="")
    parser.add_argument("--max", type=int, default=15, help="Max new candidates to return")
    parser.add_argument("--max-queries", type=int, default=8, help="Cap query count for cost control")
    parser.add_argument("--per-query-timeout", type=int, default=30)
    parser.add_argument("--throttle", type=float, default=2.0, help="Seconds between queries")
    parser.add_argument("--dry-run", action="store_true", help="Resolve queries only, don't fetch")
    parser.add_argument("--list-categories", action="store_true")
    args = parser.parse_args()

    if args.list_categories:
        print(json.dumps(list_categories(), ensure_ascii=False, indent=2))
        return
    if not args.category:
        parser.error("--category required (or use --list-categories)")

    result = discover(args.category, args.country, args.region,
                      max_candidates=args.max, max_queries=args.max_queries,
                      per_query_timeout=args.per_query_timeout, throttle_s=args.throttle,
                      dry_run=args.dry_run)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
