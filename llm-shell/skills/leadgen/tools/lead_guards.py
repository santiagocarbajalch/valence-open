#!/usr/bin/env python3
import json
import re
import unicodedata
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

ROLE_WORDS = {
    "admin",
    "administracion",
    "assistant",
    "asistente",
    "commercial",
    "compras",
    "contact",
    "contacto",
    "cotizaciones",
    "ejecutiva",
    "gerencia",
    "import",
    "importaciones",
    "info",
    "marketing",
    "operations",
    "procurement",
    "sales",
    "soporte",
    "team",
    "ventas",
}

LEGAL_SUFFIXES = {
    "sa", "s a", "s.a", "sac", "s a c", "s.a.c", "srl", "s r l", "s.r.l", "ltda", "ltda.",
    "sas", "s a s", "s.a.s", "cia", "cia.", "cia ltda", "co", "company", "corp", "inc", "llc",
}


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower().strip()
    value = value.replace("&", " and ")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def normalize_company(value: str) -> str:
    text = normalize_text(value)
    if not text:
        return ""
    parts = [part for part in text.split() if part not in LEGAL_SUFFIXES]
    return " ".join(parts).strip() or text


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def email_domain(email: str) -> str:
    email = normalize_email(email)
    return email.split("@", 1)[1] if "@" in email else ""


# ---------------------------------------------------------------------------
# Canonical registrable-root logic — SINGLE SOURCE OF TRUTH.
# prepare_candidates._reg_root, process_leads_batch._reg_root and
# curated_discovery._registrable_root used to be three copy-pasted impls (drift
# risk flagged in the 2026-06-24 system review); they now all delegate here.
# Handles two-level public suffixes (com.br, co.za, com.co) and tolerates being
# handed a full URL, a bare host, or an email's domain part.
# ---------------------------------------------------------------------------
_SLD_SUFFIXES = {"com", "co", "net", "org", "gob", "gov", "edu", "ac", "go", "or",
                 "ind", "mil", "biz", "info"}


def registrable_root(host: str) -> str:
    host = (host or "").lower().split("@")[-1].strip()
    host = host.split("//")[-1].split("/")[0]            # tolerate URL or bare host
    if host.startswith("www."):
        host = host[4:]
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    if len(labels[-1]) == 2 and labels[-2] in _SLD_SUFFIXES:   # <sld>.<cc> two-level suffix
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def company_name_from_domain(host: str) -> str:
    """Human-ish company name from the REGISTRABLE root's first label, NOT the raw
    subdomain. Fixes eng.example-university.edu -> "ExampleUniversity" (was "Eng")."""
    root = registrable_root(host)
    first = root.split(".")[0] if root else ""
    return first.capitalize() if first else (host or "")


def person_name_score(name: str) -> int:
    text = normalize_text(name)
    if not text:
        return 0
    words = text.split()
    if len(words) >= 2 and all(word not in ROLE_WORDS for word in words):
        return 3
    if text not in ROLE_WORDS:
        return 2
    return 1


def completeness_score(lead: Dict) -> int:
    score = 0
    for field in [
        "institution", "institution_type", "country", "contact_name", "title", "email", "phone", "source_url", "notes"
    ]:
        value = lead.get(field)
        if isinstance(value, str) and value.strip():
            score += 1
    score += person_name_score(lead.get("contact_name", ""))
    title = normalize_text(lead.get("title", ""))
    if title and title not in ROLE_WORDS:
        score += 1
    verification = lead.get("verification") or {}
    reason = (verification.get("reason") or "").strip()
    if reason:
        score += 1
    return score


def duplicate_keys(lead: Dict) -> List[Tuple[str, str]]:
    institution = normalize_company(lead.get("institution", ""))
    domain = email_domain(lead.get("email", ""))
    email = normalize_email(lead.get("email", ""))
    keys: List[Tuple[str, str]] = []
    if email:
        keys.append(("email", email))
    if institution:
        keys.append(("institution", institution))
    if domain:
        keys.append(("domain", domain))
    return keys


def choose_best(existing: Dict, candidate: Dict) -> Tuple[Dict, Dict, str]:
    existing_score = completeness_score(existing)
    candidate_score = completeness_score(candidate)
    if candidate_score > existing_score:
        return candidate, existing, "candidate_more_complete"
    if candidate_score < existing_score:
        return existing, candidate, "existing_more_complete"

    existing_person = person_name_score(existing.get("contact_name", ""))
    candidate_person = person_name_score(candidate.get("contact_name", ""))
    if candidate_person > existing_person:
        return candidate, existing, "candidate_more_specific_contact"
    if candidate_person < existing_person:
        return existing, candidate, "existing_more_specific_contact"

    existing_email = normalize_email(existing.get("email", ""))
    candidate_email = normalize_email(candidate.get("email", ""))
    if existing_email and candidate_email and candidate_email < existing_email:
        return candidate, existing, "candidate_email_tiebreak"
    return existing, candidate, "existing_tiebreak"


def dedupe_leads(leads: Iterable[Dict]) -> Tuple[List[Dict], List[Dict]]:
    unique: List[Dict] = []
    key_to_index: Dict[Tuple[str, str], int] = {}
    dropped: List[Dict] = []

    for lead in leads:
        lead = dict(lead)
        matches = []
        for key in duplicate_keys(lead):
            if key in key_to_index:
                matches.append(key_to_index[key])
        if not matches:
            unique.append(lead)
            new_index = len(unique) - 1
            for key in duplicate_keys(lead):
                key_to_index[key] = new_index
            continue

        index = matches[0]
        kept, removed, reason = choose_best(unique[index], lead)
        unique[index] = kept
        for key in duplicate_keys(kept):
            key_to_index[key] = index
        dropped.append({
            "reason": reason,
            "removed": removed,
            "kept": {
                "institution": kept.get("institution"),
                "email": kept.get("email"),
                "contact_name": kept.get("contact_name"),
            },
        })
        if kept is lead:
            for key in duplicate_keys(lead):
                key_to_index[key] = index

    return unique, dropped


def dedupe_send_entries(entries: Iterable[Dict]) -> Tuple[List[Dict], List[Dict]]:
    unique: List[Dict] = []
    seen = {}
    dropped: List[Dict] = []
    for entry in entries:
        entry = dict(entry)
        institution = normalize_company(entry.get("institution", ""))
        recipient = normalize_email(entry.get("recipient", ""))
        domain = email_domain(recipient)
        keys = [("recipient", recipient)] if recipient else []
        if institution:
            keys.append(("institution", institution))
        if domain:
            keys.append(("domain", domain))
        hit = next((seen[key] for key in keys if key in seen), None)
        if hit is None:
            unique.append(entry)
            idx = len(unique) - 1
            for key in keys:
                seen[key] = idx
            continue
        kept, removed, reason = choose_best(unique[hit], entry)
        unique[hit] = kept
        for key in [("recipient", normalize_email(kept.get("recipient", ""))), ("institution", normalize_company(kept.get("institution", ""))), ("domain", email_domain(kept.get("recipient", "")))]:
            if key[1]:
                seen[key] = hit
        dropped.append({
            "reason": reason,
            "removed": {
                "lead": removed.get("lead"),
                "institution": removed.get("institution"),
                "recipient": removed.get("recipient"),
                "subject": removed.get("subject"),
            },
            "kept": {
                "lead": kept.get("lead"),
                "institution": kept.get("institution"),
                "recipient": kept.get("recipient"),
            },
        })
    return unique, dropped


def append_jsonl(path: Path, record: Dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# ICP GEOGRAPHY GUARD
# Restored 2026-06-22 from the mirror .pyc after the ~/.claude wipe dropped it
# from the reconstructed source (cadence_gate.py imports it). Logic recovered
# verbatim from lead_guards.cpython-312.pyc bytecode. Data source of truth is
# geo-allow.json — edit the list THERE, not here (a hardcoded copy once drifted from it).
# ---------------------------------------------------------------------------
_GEO_ALLOW_PATH = Path('/opt/velab/vault/reference/geo-allow.json')

_GEO_ALLOW_FALLBACK = frozenset({
    'peru', 'argentina', 'venezuela', 'costa rica', 'united arab emirates', 'usa',
    'guatemala', 'el salvador', 'caribbean', 'latam', 'philippines', 'india', 'brazil',
    'united states', 'us', 'brasil', 'uruguay', 'honduras', 'emiratos arabes unidos',
    'colombia', 'u.a.e', 'ecuador', 'estados unidos', 'paraguay', 'uae', 'chile',
    'south africa', 'nicaragua', 'dominican republic', 'bolivia', 'panama',
    'central america', 'republica dominicana', 'andes',
})


def _load_icp_countries():
    """Build the normalized ICP country match-set from geo-allow.json.
    Falls back to the inline set (Mexico-free) if the file is unavailable."""
    try:
        data = json.loads(_GEO_ALLOW_PATH.read_text(encoding='utf-8'))
        tokens = set()
        for name in data.get('countries', []):
            tokens.add(normalize_text(name))
        for tok in data.get('guard_extra_tokens', []):
            tokens.add(normalize_text(tok))
        tokens.discard('')
        tokens.discard('mexico')
        if tokens:
            return tokens
        return set(_GEO_ALLOW_FALLBACK)
    except Exception:
        return set(_GEO_ALLOW_FALLBACK)


ICP_COUNTRIES = _load_icp_countries()
NON_ICP_PHONE_CC = re.compile(
    r'\+\s?(?!971)(?!27)(?!91)(?!63)(?!84)(2\d{1,2}|3\d{1,2}|4\d{1,2}|6\d{1,2}|7|8\d{1,2}|9\d{1,2})\b')
NON_ICP_DOMAIN = re.compile(
    r'(-me\.com$|\.(sa|qa|kw|om|bh|jo|eg|il|tr|pk|cn|ru|ng|ke|eu|uk|de|fr|es|it)$)')


def geo_guard(lead_or_entry):
    """Return geography violations for a lead or pack entry ([] == passes).

    SEND-PATH USE REMOVED per operator ruling 2026-07-13 (cadence_gate was the
    only caller, grep-verified): geography is bounded at lead SOURCING and at
    COLD-01 batch composition, never at the send gate. Kept for sourcing-side
    callers. Note the marker sets above are stale vs the 2026-06-22 ICP
    expansion (MENA/Kenya/Nigeria now in scope) — re-derive from geo-allow.json
    before wiring this anywhere new.
    Checks: country in ICP allowlist (EMPTY country = violation — never assume,
    never backfill from a batch label), non-ICP phone country code anywhere in
    phone/notes, non-ICP domain suffix on the email."""
    v = []
    country = normalize_text(lead_or_entry.get('country', '') or '')
    if not country:
        v.append('GEO: country EMPTY — geography unproven; verify before any outreach '
                 '(never backfill from a batch label)')
    elif country not in ICP_COUNTRIES:
        v.append('GEO: country %r outside ICP (LatAm + US only)' % lead_or_entry.get('country'))
    blob = f"{lead_or_entry.get('phone', '') or ''} {lead_or_entry.get('notes', '') or ''}"
    m = NON_ICP_PHONE_CC.search(blob)
    if m:
        v.append('GEO: non-ICP phone country code %s in phone/notes' % m.group(0))
    dom = email_domain(lead_or_entry.get('email', '')
                       or lead_or_entry.get('to_email', '')
                       or lead_or_entry.get('recipient', ''))
    if dom and NON_ICP_DOMAIN.search(dom):
        v.append('GEO: domain %r carries a non-ICP geography marker' % dom)
    return v
