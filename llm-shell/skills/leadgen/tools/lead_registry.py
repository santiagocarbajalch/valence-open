#!/usr/bin/env python3
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from lead_guards import email_domain, normalize_company, normalize_email
from velab_batch import load_batch_leads

ROOT = Path.home() / "velab"
VAULT = ROOT / "vault"
LEADS_DIR = VAULT / "leads"
RAW_DIR = LEADS_DIR / "raw"
VERIFIED_DIR = LEADS_DIR / "verified"
REJECTED_DIR = LEADS_DIR / "rejected"
SYSTEM_DIR = LEADS_DIR / "system"
REGISTRY_PATH = SYSTEM_DIR / "lead_registry.json"

KEY_MAP = {
    "email": "by_email",
    "institution": "by_institution",
    "domain": "by_domain",
}

BUCKET_PRIORITY = {
    "verified": 3,
    "raw": 2,
    "review": 2,
    "rejected": 1,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def default_registry() -> Dict:
    return {
        "version": 1,
        "updated_at": utc_now(),
        "by_email": {},
        "by_institution": {},
        "by_domain": {},
    }


def load_registry() -> Dict:
    if not REGISTRY_PATH.exists():
        return default_registry()
    with REGISTRY_PATH.open(encoding="utf-8") as fh:
        data = json.load(fh)
    registry = default_registry()
    registry.update({k: v for k, v in data.items() if k in registry})
    return registry


def save_registry(registry: Dict) -> None:
    registry["updated_at"] = utc_now()
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with REGISTRY_PATH.open("w", encoding="utf-8") as fh:
        json.dump(registry, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def infer_bucket(path: Path) -> Optional[str]:
    parent = path.parent.name.lower()
    if parent == "verified":
        return "verified"
    if parent == "rejected":
        return "rejected"
    if parent == "raw":
        return "raw"
    return None


def batch_id_for_path(path: Path) -> str:
    stem = path.stem
    if stem.startswith("batch-"):
        stem = stem[6:]
    for suffix in ("-verified", "-rejected", "-review"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return stem


def lead_summary(lead: Dict, bucket: str, source_path: Path) -> Dict:
    return {
        "institution": lead.get("institution"),
        "email": normalize_email(lead.get("email", "")),
        "domain": email_domain(lead.get("email", "")),
        "contact_name": lead.get("contact_name"),
        "country": lead.get("country"),
        "bucket": bucket,
        "batch_id": batch_id_for_path(source_path),
        "source_path": str(source_path),
        "source_url": lead.get("source_url"),
        "updated_at": utc_now(),
    }


def reserved_keys_for_bucket(lead: Dict, bucket: str) -> List[Tuple[str, str]]:
    keys: List[Tuple[str, str]] = []
    email = normalize_email(lead.get("email", ""))
    institution = normalize_company(lead.get("institution", ""))
    domain = email_domain(lead.get("email", ""))

    if email:
        keys.append(("email", email))
    if bucket == "verified":
        if institution:
            keys.append(("institution", institution))
        if domain:
            keys.append(("domain", domain))
    return keys


def register_lead(registry: Dict, lead: Dict, bucket: str, source_path: Path) -> None:
    record = lead_summary(lead, bucket, source_path)
    for key_type, key in reserved_keys_for_bucket(lead, bucket):
        registry[KEY_MAP[key_type]][key] = record


def register_leads(registry: Dict, leads: Iterable[Dict], bucket: str, source_path: Path) -> None:
    for lead in leads:
        register_lead(registry, lead, bucket, source_path)


def rebuild_registry() -> Dict:
    registry = default_registry()
    for directory in [VERIFIED_DIR, RAW_DIR, REJECTED_DIR]:
        for path in sorted(directory.glob("*.json")):
            bucket = infer_bucket(path)
            if not bucket:
                continue
            # load_batch_leads transparently unwraps v1 dict batches AND legacy
            # bare arrays, so the migrated dict-wrapped files are no longer skipped.
            for lead in load_batch_leads(path):
                if isinstance(lead, dict):
                    register_lead(registry, lead, bucket, path)
    save_registry(registry)
    return registry


def ensure_registry(force_rebuild: bool = False) -> Dict:
    if force_rebuild or not REGISTRY_PATH.exists():
        return rebuild_registry()
    return load_registry()


def find_conflict(registry: Dict, lead: Dict, candidate_bucket: str, current_batch_id: str) -> Optional[Dict]:
    for key_type, key in reserved_keys_for_bucket(lead, candidate_bucket):
        record = registry[KEY_MAP[key_type]].get(key)
        if not record:
            continue
        if record.get("batch_id") == current_batch_id:
            continue

        existing_bucket = record.get("bucket", "raw")

        if candidate_bucket == "verified":
            if key_type in {"institution", "domain"}:
                return {
                    "action": "blocked",
                    "key_type": key_type,
                    "key": key,
                    "existing": record,
                    "reason": f"verified_{key_type}_already_reserved",
                }
            if existing_bucket == "verified":
                return {
                    "action": "blocked",
                    "key_type": key_type,
                    "key": key,
                    "existing": record,
                    "reason": "verified_email_already_reserved",
                }
            return {
                "action": "upgrade",
                "key_type": key_type,
                "key": key,
                "existing": record,
                "reason": f"candidate_{candidate_bucket}_upgrades_{existing_bucket}",
            }

        return {
            "action": "blocked",
            "key_type": key_type,
            "key": key,
            "existing": record,
            "reason": f"email_already_seen_in_{existing_bucket}",
        }

    return None


def filter_new_leads(registry: Dict, leads: Iterable[Dict], candidate_bucket: str, current_batch_id: str) -> Tuple[List[Dict], List[Dict], List[Dict]]:
    kept: List[Dict] = []
    blocked: List[Dict] = []
    upgrades: List[Dict] = []
    working_registry = json.loads(json.dumps(registry))

    for lead in leads:
        lead = dict(lead)
        conflict = find_conflict(working_registry, lead, candidate_bucket, current_batch_id)
        if conflict and conflict["action"] == "blocked":
            blocked.append({
                "reason": conflict["reason"],
                "key_type": conflict["key_type"],
                "key": conflict["key"],
                "existing": conflict["existing"],
                "removed": {
                    "institution": lead.get("institution"),
                    "email": lead.get("email"),
                    "contact_name": lead.get("contact_name"),
                    "source_url": lead.get("source_url"),
                },
            })
            continue

        if conflict and conflict["action"] == "upgrade":
            upgrades.append({
                "reason": conflict["reason"],
                "key_type": conflict["key_type"],
                "key": conflict["key"],
                "replaced": conflict["existing"],
                "kept": {
                    "institution": lead.get("institution"),
                    "email": lead.get("email"),
                    "contact_name": lead.get("contact_name"),
                    "source_url": lead.get("source_url"),
                },
            })

        kept.append(lead)
        synthetic_name = f"{current_batch_id}-review.json" if candidate_bucket == "raw" else f"{current_batch_id}-{candidate_bucket}.json"
        register_lead(working_registry, lead, candidate_bucket, Path(synthetic_name))

    return kept, blocked, upgrades
