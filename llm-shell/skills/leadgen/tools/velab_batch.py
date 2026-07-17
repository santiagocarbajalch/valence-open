"""velab_batch — v1 lead-batch naming convention helpers (shared by the tools).

See vault/reference/batch-naming-convention.md. A v1 lead batch is a dict:
  { schema, batch_id, date, client_type, geo, variant, status, count, leads:[...] }
Legacy files are bare arrays. `load_batch_leads` reads either transparently.
The derivation (client_type / geo / variant) mirrors the JS migration planner so
new files Explorador/process_leads_batch writes match the migrated names exactly.
"""
from __future__ import annotations
import json, re, unicodedata
from collections import Counter
from pathlib import Path

SCHEMA = "velab.lead-batch/v1"


def kebab(s) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


# ── read: unwrap v1 dict OR legacy bare array ────────────────────────────────
def load_batch_leads(src) -> list:
    """Return the leads list from a path/str/loaded-object, v1 dict or bare array."""
    if isinstance(src, (str, Path)):
        try:
            data = json.loads(Path(src).read_text(encoding="utf-8"))
        except Exception:
            return []
    else:
        data = src
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        leads = data.get("leads")
        return leads if isinstance(leads, list) else []
    return []


def is_v1(src) -> bool:
    try:
        data = json.loads(Path(src).read_text(encoding="utf-8")) if isinstance(src, (str, Path)) else src
    except Exception:
        return False
    return isinstance(data, dict) and "leads" in data


# ── derive: client_type / geo / variant (mirrors the JS planner) ─────────────
_TYPE_FROM_INSTTYPE = [
    (r"lab.*equip.*distrib|^distributor$|distribuidor", "lab-distributor"),
    (r"school dist|k-?12", "school-district"),
    (r"univ", "university-procurement"),
    (r"environ", "environmental-lab"),
    (r"hospital|clinic|clínic", "clinical-lab"),
]
_TYPE_FROM_SLUG = [
    (r"school-dist|k-?12", "school-district"),
    (r"univers", "university-procurement"),
    (r"environmental|env-lab", "environmental-lab"),
    (r"distrib|lab\d*-|lab-distrib|andes|latam|mena|south-america|sa-", "lab-distributor"),
    (r"clinic|hospital", "clinical-lab"),
]
_GEO_DICT = [
    (r"non-mexico", "latam"),
    (r"\bcosta\b|costa-rica", "costa-rica"), (r"domrep|dominican", "dominican-republic"),
    (r"colombia", "colombia"), (r"\bperu\b", "peru"), (r"chile", "chile"),
    (r"ecuador", "ecuador"), (r"panama", "panama"), (r"mexico", "mexico"), (r"brazil", "brazil"),
    (r"morocco", "morocco"), (r"jordan", "jordan"), (r"saudi", "saudi-arabia"),
    (r"\buae\b", "uae"), (r"bahrain", "bahrain"), (r"egypt", "egypt"),
    (r"texas", "texas-us"), (r"ohio", "ohio-us"),
    (r"andes", "andes"), (r"\blatam\b", "latam"), (r"\bmena\b", "mena"),
    (r"south-america|\bsa-", "south-america"),
    (r"\bus-|\bus\b|united-states", "united-states"),
]
_VARIANTS = [
    (r"consolidated", "consolidated"), (r"\bfinal\b", "final"), (r"topup|top-up", "topup"),
    (r"geogate", "geogate"), (r"\bdeep\b", "deep"), (r"\btuned\b", "tuned"),
    (r"\bnew\b", "new"), (r"unique-(company-)?pass", "unique-pass"),
    (r"workable-?\d+", "workable"), (r"\bfresh\b", "fresh"), (r"reverified", "reverified"),
    (r"additional", "additional"), (r"\bfocus\b", "focus"), (r"top20", "top20"), (r"\btest\b", "test"),
]
_COUNTRY_CANON = {"united states": "united-states", "usa": "united-states"}


def _modal(values):
    c = Counter(v.strip() for v in values if v and str(v).strip())
    return c.most_common(1)[0][0] if c else ""


def client_type(leads, slug="") -> str:
    inst = _modal(l.get("institution_type") or l.get("type") for l in leads)
    if inst:
        for rx, v in _TYPE_FROM_INSTTYPE:
            if re.search(rx, inst, re.I):
                return v
    for rx, v in _TYPE_FROM_SLUG:
        if re.search(rx, slug, re.I):
            return v
    if inst:
        return kebab(inst)
    return "lab-distributor"   # Velab ICP default (operator-confirmed)


def geo_token(leads, slug="") -> str:
    for rx, v in _GEO_DICT:
        if re.search(rx, slug, re.I):
            return v
    country = _modal(l.get("country") for l in leads)
    if country:
        return _COUNTRY_CANON.get(country.lower(), kebab(country))
    return "unknown-geo"


def variant_tag(slug="") -> str:
    for rx, v in _VARIANTS:
        if re.search(rx, slug, re.I):
            return v
    return ""


def v1_basename(leads, slug="", date="", existing_names=None) -> str:
    ct, geo, var = client_type(leads, slug), geo_token(leads, slug), variant_tag(slug)
    base = f"{date}__{ct}__{geo}" + (f"__{var}" if var else "")
    if existing_names:
        name, n = base, 1
        while f"{name}.json" in existing_names:
            n += 1
            name = f"{base}__{n:02d}"
        return name
    return base


def wrap_lead_batch(leads, *, date="", slug="", status="active", legacy_filename=None, batch_id=None) -> dict:
    ct, geo, var = client_type(leads, slug), geo_token(leads, slug), variant_tag(slug)
    return {
        "schema": SCHEMA,
        "batch_id": batch_id or "",
        "date": date, "client_type": ct, "geo": geo, "variant": var or None,
        "status": status, "legacy_filename": legacy_filename,
        "count": len(leads), "leads": leads,
    }
