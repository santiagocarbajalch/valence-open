#!/usr/bin/env python3
"""expand_categories.py — additively expand ICP category query branches.

The lab-equipment-distributor category was richly built (es/pt/geo + Mexico BLOCK); the
other 21 were English-only stubs with NO `languages_by_country` — which also meant Mexico
was NOT blocked for them (a guardrail hole) and their Spanish/Portuguese reach was thin.

This script, for each category below:
  - adds the standard LATAM `languages_by_country` map (Mexico BLOCKED, Brazil pt, LATAM es),
  - merges authored, geo-anchored, sub-sector-spread queries into queries_en/es/pt,
  - dedupes and is fully additive (never deletes an existing query),
  - backs up the data file first.

Run once: /usr/bin/python3 expand_categories.py  (or --dry-run to preview counts).
"""
import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data" / "source_discovery_queries.json"

# Shared LATAM map — Mexico BLOCKED (parent-company territory), Brazil pt, LATAM es.
STD_LANGS = {
    "default": "en",
    "Peru": "es", "Argentina": "es", "Colombia": "es", "Chile": "es", "Ecuador": "es",
    "Bolivia": "es", "Paraguay": "es", "Uruguay": "es", "Venezuela": "es",
    "Costa Rica": "es", "Panama": "es", "Guatemala": "es", "Dominican Republic": "es",
    "Spain": "es", "Brazil": "pt", "Mexico": "BLOCKED",
}

# Per-category authored query sets ({country} is filled by the discovery tool).
# Focus: LATAM-relevant lab/end-user categories that buy microscopes/balances/centrifuges/
# reagents. US-centric categories (k12/community-college/forensic/cannabis/etc.) keep their
# English stubs — LATAM geo-anchoring doesn't apply to them.
CATS = {
    "clinical-laboratory": {
        "en": [
            "clinical laboratory {country} contact",
            "diagnostic laboratory {country} directory",
            "pathology laboratory {country}",
            "medical analysis laboratory {country} contact",
            "private clinical lab {country} purchasing",
        ],
        "es": [
            "laboratorio clínico {country} contacto",
            "laboratorio de análisis clínicos {country}",
            "laboratorio de patología {country}",
            "directorio laboratorios clínicos {country}",
            "laboratorio diagnóstico {country} compras",
            "red de laboratorios clínicos {country}",
            "laboratorio de microbiología clínica {country}",
            "laboratorio bioquímico {country} contacto",
        ],
        "pt": [
            "laboratório de análises clínicas {country} contato",
            "laboratório de patologia {country}",
            "laboratório clínico {country} compras",
        ],
    },
    "veterinary-diagnostic-lab": {
        "en": [
            "veterinary diagnostic laboratory {country} contact",
            "animal health laboratory {country}",
            "veterinary pathology lab {country}",
            "poultry diagnostic laboratory {country}",
        ],
        "es": [
            "laboratorio de diagnóstico veterinario {country} contacto",
            "laboratorio veterinario {country}",
            "laboratorio sanidad animal {country}",
            "laboratorio diagnóstico avícola {country}",
            "laboratorio patología veterinaria {country}",
            "directorio laboratorios veterinarios {country}",
        ],
        "pt": [
            "laboratório de diagnóstico veterinário {country} contato",
            "laboratório de sanidade animal {country}",
        ],
    },
    "food-beverage-qc-lab": {
        "en": [
            "food testing laboratory {country} contact",
            "food quality control lab {country}",
            "beverage laboratory {country}",
            "food safety microbiology lab {country}",
            "bromatology laboratory {country}",
        ],
        "es": [
            "laboratorio control de calidad alimentos {country} contacto",
            "laboratorio bromatológico {country}",
            "laboratorio análisis de alimentos {country}",
            "laboratorio microbiología de alimentos {country}",
            "laboratorio inocuidad alimentaria {country}",
            "laboratorio de bebidas {country}",
            "directorio laboratorios de alimentos {country}",
        ],
        "pt": [
            "laboratório de análise de alimentos {country} contato",
            "laboratório controle de qualidade alimentos {country}",
            "laboratório bromatologia {country}",
        ],
    },
    "mining-assay-lab": {
        "en": [
            "mining assay laboratory {country} contact",
            "mineral analysis laboratory {country}",
            "geochemistry assay lab {country}",
            "ore testing laboratory {country}",
        ],
        "es": [
            "laboratorio de ensayo minero {country} contacto",
            "laboratorio de análisis de minerales {country}",
            "laboratorio geoquímico {country}",
            "laboratorio metalúrgico {country}",
            "laboratorio análisis de menas {country}",
            "directorio laboratorios mineros {country}",
        ],
        "pt": [
            "laboratório de ensaios minerais {country} contato",
            "laboratório geoquímico {country}",
        ],
    },
    "water-environmental-testing-lab": {
        "en": [
            "water testing laboratory {country} contact",
            "environmental laboratory {country}",
            "wastewater analysis lab {country}",
            "soil testing laboratory {country}",
        ],
        "es": [
            "laboratorio análisis de agua {country} contacto",
            "laboratorio ambiental {country}",
            "laboratorio de aguas residuales {country}",
            "laboratorio análisis de suelos {country}",
            "laboratorio microbiología ambiental {country}",
            "directorio laboratorios ambientales {country}",
        ],
        "pt": [
            "laboratório de análise de água {country} contato",
            "laboratório ambiental {country}",
        ],
    },
    "pharma-qc-lab": {
        "en": [
            "pharmaceutical quality control laboratory {country} contact",
            "pharma manufacturer QC lab {country}",
            "pharmaceutical analysis laboratory {country}",
        ],
        "es": [
            "laboratorio control de calidad farmacéutico {country} contacto",
            "laboratorio farmacéutico {country} compras",
            "laboratorio análisis farmacéutico {country}",
            "industria farmacéutica {country} control de calidad",
            "laboratorio fisicoquímico farmacéutico {country}",
        ],
        "pt": [
            "laboratório controle de qualidade farmacêutico {country} contato",
            "indústria farmacêutica {country} controle de qualidade",
        ],
    },
    "cosmetic-qc-lab": {
        "en": [
            "cosmetic manufacturer QC laboratory {country} contact",
            "personal care products testing lab {country}",
            "cosmetics quality control lab {country}",
        ],
        "es": [
            "laboratorio control de calidad cosméticos {country} contacto",
            "fabricante cosméticos {country} laboratorio",
            "laboratorio análisis cosméticos {country}",
            "industria cosmética {country} control de calidad",
        ],
        "pt": [
            "laboratório controle de qualidade cosméticos {country} contato",
            "indústria cosmética {country} laboratório",
        ],
    },
    "research-laboratory": {
        "en": [
            "research laboratory {country} contact purchasing",
            "university research lab {country} equipment",
            "independent research institute {country} laboratory",
        ],
        "es": [
            "laboratorio de investigación {country} contacto",
            "instituto de investigación {country} laboratorio",
            "centro de investigación científica {country}",
            "laboratorio universitario investigación {country} compras",
        ],
        "pt": [
            "laboratório de pesquisa {country} contato",
            "instituto de pesquisa {country} laboratório",
        ],
    },
    "cell-culture-biotech-lab": {
        "en": [
            "biotech laboratory {country} contact",
            "cell culture laboratory {country}",
            "biotechnology company {country} lab",
        ],
        "es": [
            "laboratorio de biotecnología {country} contacto",
            "laboratorio cultivo celular {country}",
            "empresa biotecnológica {country} laboratorio",
            "laboratorio biología molecular {country}",
        ],
        "pt": [
            "laboratório de biotecnologia {country} contato",
            "laboratório cultura celular {country}",
        ],
    },
    "materials-science-lab": {
        "en": [
            "materials testing laboratory {country} contact",
            "metallurgical laboratory {country}",
            "materials science lab {country}",
        ],
        "es": [
            "laboratorio de ensayo de materiales {country} contacto",
            "laboratorio metalúrgico {country}",
            "laboratorio de ciencia de materiales {country}",
            "laboratorio de control de calidad industrial {country}",
        ],
        "pt": [
            "laboratório de ensaio de materiais {country} contato",
            "laboratório metalúrgico {country}",
        ],
    },
}


def merge(dry_run=False):
    spec = json.loads(DATA.read_text(encoding="utf-8"))
    cats = spec["categories"]
    report = []
    for key, langs in CATS.items():
        if key not in cats:
            report.append((key, "MISSING in spec — skipped"))
            continue
        block = cats[key]
        before = {f: len(block.get(f, [])) for f in ("queries_en", "queries_es", "queries_pt")}
        # languages_by_country (adds Mexico BLOCK + LATAM es/pt). Merge, don't clobber.
        lbc = block.setdefault("languages_by_country", {})
        for k, v in STD_LANGS.items():
            lbc.setdefault(k, v)
        # merge query arrays additively + dedupe (preserve order)
        for field, items in (("queries_en", langs.get("en", [])),
                             ("queries_es", langs.get("es", [])),
                             ("queries_pt", langs.get("pt", []))):
            existing = block.get(field, [])
            seen = set(existing)
            for q in items:
                if q not in seen:
                    existing.append(q)
                    seen.add(q)
            block[field] = existing
        after = {f: len(block.get(f, [])) for f in ("queries_en", "queries_es", "queries_pt")}
        report.append((key, f"en {before['queries_en']}->{after['queries_en']}, "
                            f"es {before['queries_es']}->{after['queries_es']}, "
                            f"pt {before['queries_pt']}->{after['queries_pt']}, +Mexico BLOCK"))

    if dry_run:
        for k, msg in report:
            print(f"  {k}: {msg}")
        print(f"\n(dry-run — no write) categories touched: {len(report)}")
        return

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = DATA.with_suffix(f".json.bak-{stamp}-expand")
    shutil.copy2(DATA, backup)
    spec.setdefault("_meta", {})["last_category_expansion"] = stamp
    DATA.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for k, msg in report:
        print(f"  {k}: {msg}")
    print(f"\nbacked up -> {backup.name}; wrote {DATA.name}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.parse_args()
    merge(dry_run=ap.parse_args().dry_run)
