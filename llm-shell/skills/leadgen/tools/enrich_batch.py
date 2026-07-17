#!/usr/bin/env python3
"""enrich_batch.py — geo-aware phone + role-title backfill on a raw scrape batch, in place.

Replaces the per-geo phone regex hand-written each batch (+54/+57/+27/+84 ...). Looks up the
country's phone code, pulls a clean phone from each lead's _raw_snippet (fax-guarded), and tags
role inboxes. Names are NEVER invented — empty beats guessed (operator rule).

  enrich_batch.py ~/velab/vault/leads/raw/batch-<...>.json --country Vietnam
"""
import argparse
import json
import re
from pathlib import Path

# Country -> international dialing code (the geos we mine). Extend as new markets open.
PHONE_CC = {
    "Argentina": "54", "Bolivia": "591", "Brazil": "55", "Chile": "56", "Colombia": "57",
    "Costa Rica": "506", "Dominican Republic": "1", "Ecuador": "593", "El Salvador": "503",
    "Guatemala": "502", "Honduras": "504", "Mexico": "52", "Nicaragua": "505", "Panama": "507",
    "Paraguay": "595", "Peru": "51", "Uruguay": "598", "Venezuela": "58",
    "Philippines": "63", "Indonesia": "62", "Malaysia": "60", "Vietnam": "84", "Thailand": "66",
    "South Africa": "27", "Kenya": "254", "Nigeria": "234", "Ghana": "233",
    "United Arab Emirates": "971", "Saudi Arabia": "966", "Egypt": "20", "Jordan": "962",
    "Qatar": "974", "Kuwait": "965",
}

ROLE = {"info", "sales", "ventas", "ventas1", "ventas2", "contact", "contacto", "comercial",
        "administracion", "admin", "gerencia", "compras", "atencionalcliente", "clientes",
        "marketing", "rrhh", "pedidos", "laboratorio", "tecnica", "servicio", "servicios",
        "enquiries", "inquiries", "orders", "support", "soporte", "mail", "correo", "hello",
        "hola", "reception", "accounts", "kinhdoanh", "cskh", "lienhe", "baogia", "baixu"}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("batch")
    ap.add_argument("--country", required=True)
    a = ap.parse_args()
    cc = PHONE_CC.get(a.country)
    leads = json.loads(Path(a.batch).read_text())

    ph_re = ph_re2 = None
    if cc:
        ph_re = re.compile(r'(?:tel|tel\.|tele|phone|hotline|whatsapp|cel|m[oó]vil|movil|pbx|call|t:)'
                           r'[:.\s]*(\+?\s?' + cc + r'[\s\-\(\)\.]*\d[\d\s\-\(\)\.]{6,}\d)', re.I)
        ph_re2 = re.compile(r'(\+\s?' + cc + r'[\s\-\(\)\.]*\d[\d\s\-\(\)\.]{6,}\d)')

    phones = titles = 0
    for L in leads:
        e = (L.get("email") or "").lower()
        local = e.split("@")[0] if "@" in e else ""
        if not L.get("title") and local in ROLE:
            L["title"] = "Role inbox"; titles += 1
        if not L.get("phone") and ph_re:
            s = L.get("_raw_snippet", "") or ""
            m = ph_re.search(s) or ph_re2.search(s)
            if m:
                p = re.sub(r'\s{2,}', ' ', m.group(1).strip())
                i = s.lower().find(p.lower())
                if not (i > 0 and 'fax' in s.lower()[max(0, i - 12):i]):
                    L["phone"] = p; phones += 1

    Path(a.batch).write_text(json.dumps(leads, ensure_ascii=False, indent=2))
    note = "" if cc else f"  (no phone code for '{a.country}' — titles only)"
    print(f"enriched: +{phones} phones, +{titles} role titles, {len(leads)} records{note}")


if __name__ == "__main__":
    main()
