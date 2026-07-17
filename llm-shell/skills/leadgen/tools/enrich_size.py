#!/opt/scrapling-venv/bin/python3
"""enrich_size.py — EXTERNAL size/buying-power indices for candidate qualification.

A company's own website can't tell us if it's a real buyer — every distributor, tiny or huge,
calls itself "líder a nivel nacional", lists brands, and shows two cities. And judging by how
polished a site is would reject Velab itself. So size has to come from EXTERNAL hard indices
that don't depend on self-description or web polish (operator 2026-06-09, "find other indices
of size... firmographic substance is good"; NOT named decision-makers):

  - employee / company-size band  (firmographic substance, from search snippets)
  - IMPORT activity               (they're importers — customs/import records = real buying volume)
  - public-TENDER activity        (winning institutional contracts = a substantial operator)
  - verifiable LOCATIONS          (cities from third-party sources, not self-claim)
  - revenue mentions

Token-light: a few targeted searxng queries per company; Python extracts the indices from
snippets; the LLM reads the compact evidence and makes the Major/Mid/Small call. Absence of
web evidence is flagged (low_web_footprint) but NOT treated as proof of small — a real but
obscure firm must not be auto-killed (the "Velab would fail polish" caution).

Usage: enrich_size.py --candidates /tmp/<slug>-cand.json --country Bolivia [--pretty]
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import source_discovery as sd

GENERIC = re.compile(r"\b(s\.?r\.?l\.?|s\.?a\.?(?:\.c\.?)?|ltda?\.?|e\.?i\.?r\.?l\.?|"
                     r"importadora|distribuidora|laboratorios?|company|cia\.?|inc\.?|corp\.?)\b", re.I)
# Third-party data sources whose mere listing of the company is a hard index.
IMPORT_HOSTS = ("panjiva", "volza", "importgenius", "importyeti", "datamyne", "seair",
                "tradeatlas", "aduana", "trademo", "exportgenius", "comtrade")
TENDER_HOSTS = ("sicoes.gob.bo", "secop", "mercadopublico", "comprasestatales", "contratacion",
                "licitacion", "comprasapp", "guatecompras", "compraspublicas", "seace")
LINKEDIN = "linkedin.com/company"
EMP_RE = re.compile(r"(\d{1,3}(?:[.,]\d{3})*|\d{1,4})\s*[-–a]?\s*(\d{1,4})?\s*"
                    r"(?:employees|empleados|colaboradores|trabajadores)", re.I)
SIZE_BAND_RE = re.compile(r"(?:company size|tama[ñn]o de la empresa)[:\s]*([\d.,]+\s*[-–]\s*[\d.,]+|\+?[\d.,]+)", re.I)
REV_RE = re.compile(r"(?:revenue|facturaci[oó]n|ingresos|ventas anuales)\D{0,15}"
                    r"((?:us\$|usd|\$|bs\.?)?\s*[\d.,]+\s*(?:millones|million|mil|bn|m|k)?)", re.I)
CITIES = sd.LATAM_CITIES if hasattr(sd, "LATAM_CITIES") else set()
CITY_RE = re.compile(r"\b(la paz|santa cruz|cochabamba|sucre|oruro|potosi|tarija|el alto|"
                     r"lima|arequipa|bogota|medellin|cali|quito|guayaquil|santiago|"
                     r"buenos aires|asuncion|montevideo|panama|guatemala|caracas)\b")


def company_name(title, url):
    seg = re.split(r"[–\-|·:»]", title or "")[0].strip()
    seg = GENERIC.sub("", seg).strip(" -–|") if seg else ""
    if len(seg) >= 4 and not seg.lower().startswith(("inicio", "home", "bienvenid", "500", "404")):
        return seg
    host = (urlparse(url).hostname or "").replace("www.", "")
    return host.split(".")[0]


def enrich(url, title="", country="", throttle=1.5):
    name = company_name(title, url)
    host = (urlparse(url).hostname or "").replace("www.", "")
    queries = [
        f'site:linkedin.com/company {name} {country}',   # reliable employee-band source
        f'"{name}" {country}',
        f'{name} importaciones aduana panjiva',
        f'{name} {country} licitación OR adjudicación OR contrato',
    ]
    results = []
    for q in queries:
        try:
            results.extend(sd.fetch_results(q, timeout=25, lang="es") or [])
        except Exception:
            pass
        time.sleep(throttle)

    # Specific match tokens for THIS company (domain root + full name) — avoids the
    # 3-letter-fragment noise ("ats" matched everything; require "atslab" / "ats lab").
    root = host.split(".")[0]
    tokens = {root.lower()}
    if len(name) >= 5:
        tokens.add(name.lower())

    def _mentions(r):
        t = f"{r.get('title','')} {r.get('snippet','')} {r.get('url','')}".lower()
        return any(tok in t for tok in tokens)

    own = [r for r in results if _mentions(r)]          # results actually about this company
    own_blob = " ".join(f"{r.get('title','')} {r.get('snippet','')}" for r in own)

    # employee band (the spine) — parse the UPPER bound to classify. Prefer the company's
    # OWN LinkedIn page snippet (reliable); only then fall back to other attributed results.
    li_blob = " ".join(f"{r.get('title','')} {r.get('snippet','')}" for r in own
                       if "linkedin.com/company" in r.get("url", "").lower())
    emp_str, emp_max = None, None
    bm = SIZE_BAND_RE.search(li_blob) or EMP_RE.search(li_blob) or SIZE_BAND_RE.search(own_blob) or EMP_RE.search(own_blob)
    if bm:
        emp_str = bm.group(0).strip()
        nums = [int(n.replace(".", "").replace(",", "")) for n in re.findall(r"\d[\d.,]*", emp_str)]
        if nums:
            emp_max = max(nums)
    rev = REV_RE.search(own_blob)
    revenue = rev.group(1).strip() if (rev and re.search(r"\d", rev.group(1))) else None

    # import / tender records: only when the company is IN that result (attributed)
    import_hits = sorted({h for r in own for h in IMPORT_HOSTS
                          if h in (urlparse(r.get("url", "")).hostname or "").lower()})
    tender_hits = sorted({h for r in own for h in TENDER_HOSTS
                          if h in f"{urlparse(r.get('url','')).hostname or ''} {r.get('url','')}".lower()})
    linkedin_present = any(LINKEDIN in r.get("url", "").lower() for r in own)
    reach = len({urlparse(r.get("url", "")).hostname for r in own
                 if host not in (urlparse(r.get("url", "")).hostname or "")})

    # Employee-band-centric tiering (operator: firmographic substance, not site polish).
    if emp_max is not None:
        size_tier = "Small" if emp_max <= 10 else ("Mid" if emp_max <= 50 else "Major")
    else:
        # No employee data: lean on attributed import/tender records + revenue. Absence of web
        # evidence is FLAGGED, never proof of small (a real-but-obscure firm must survive review).
        corrob = (2 if import_hits else 0) + (2 if tender_hits else 0) + (1 if revenue else 0)
        size_tier = "Major" if corrob >= 4 else ("Mid" if corrob >= 2 else "Unknown")
    low_web = reach < 2 and emp_max is None and not (import_hits or tender_hits)

    return {
        "url": url, "host": host, "name": name, "country": country,
        "employee_band": emp_str, "employee_upper": emp_max, "revenue_signal": revenue,
        "import_records": import_hits, "tender_records": tender_hits,
        "linkedin_company": linkedin_present, "external_reach_hosts": reach,
        "low_web_footprint": low_web,    # flag, NOT proof of small
        "size_tier": size_tier,
        "queries": queries,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--country", default="")
    ap.add_argument("--throttle", type=float, default=1.5)
    ap.add_argument("--pretty", action="store_true")
    a = ap.parse_args()
    cands = json.loads(Path(a.candidates).read_text())
    out = []
    for c in cands:
        try:
            out.append(enrich(c["url"], c.get("title", ""), a.country, a.throttle))
        except Exception as e:
            out.append({"url": c.get("url"), "error": str(e), "prelim_tier": "Small"})
    print(json.dumps(out, ensure_ascii=False, indent=2 if a.pretty else None))


if __name__ == "__main__":
    main()
