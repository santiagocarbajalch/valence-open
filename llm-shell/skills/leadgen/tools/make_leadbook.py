#!/usr/bin/env python3
"""make_leadbook.py — render a verified lead batch as an Obsidian-native markdown leadbook.

Leads live in the Obsidian vault, so after a /leadgen run lands verified JSON we also write a
browsable markdown leadbook: YAML frontmatter (counts/tags for Obsidian queries) + a table.
Canonical data stays the JSON; this is the human/Obsidian view.

Usage:
    make_leadbook.py <verified-batch.json> [--out <path.md>]
Reads the v1 wrapper dict ({"leads": [...]}) or a bare list. Writes to
vault/leads/leadbooks/<stem>-leadbook.md unless --out is given. Prints the path written.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

VAULT = Path.home() / "velab" / "vault"
LEADBOOKS_DIR = VAULT / "leads" / "leadbooks"


def load_leads(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        return data.get("leads", []), data
    return data, {}


def _md_cell(v):
    """Make a value safe for a markdown table cell."""
    s = "" if v is None else str(v).strip()
    return s.replace("|", "\\|").replace("\n", " ") or "—"


def _mode(values):
    vals = [v for v in values if v]
    if not vals:
        return ""
    return max(set(vals), key=vals.count)


def build_leadbook(leads, wrapper, src_path: Path):
    n = len(leads)
    by_status, by_tier, named = {}, {}, 0
    countries, categories = [], []
    for l in leads:
        by_status[l.get("verification_status", "?")] = by_status.get(l.get("verification_status", "?"), 0) + 1
        by_tier[l.get("extracted_via", "?")] = by_tier.get(l.get("extracted_via", "?"), 0) + 1
        if (l.get("contact_name") or "").strip():
            named += 1
        countries.append(l.get("country") or "")
        categories.append(l.get("institution_type") or "")
    country = _mode(countries)
    category = _mode(categories)
    date = _mode([l.get("scrape_date") for l in leads]) or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    status_line = " · ".join(f"{k}: {v}" for k, v in sorted(by_status.items(), key=lambda x: -x[1]))
    tier_line = " · ".join(f"{k}: {v}" for k, v in sorted(by_tier.items(), key=lambda x: -x[1]))

    fm = [
        "---",
        f'title: "Leadbook — {category or "leads"} · {country or "—"} · {date}"',
        "type: leadbook",
        f"category: {category or 'unknown'}",
        f"country: {country or 'unknown'}",
        f"date: {date}",
        f"verified_count: {n}",
        f"named_contacts: {named}",
        f'source_batch: "{src_path.name}"',
        f"generated: {generated}",
        "tags: [leads, leadbook, " + (category.replace(' ', '-').lower() if category else "lead") + "]",
        "---",
        "",
        f"# Leadbook — {category or 'leads'} · {country or '—'} · {date}",
        "",
        f"**{n} verified leads** · {named} with a named contact · source: `{src_path.name}`",
        "",
        f"- **Verification:** {status_line or '—'}",
        f"- **Extracted via:** {tier_line or '—'}",
        "",
        "| # | Institution | Contact / Role | Title | Email | Phone | Status | Fit | Source |",
        "|---|---|---|---|---|---|---|---|---|",
    ]

    rows = []
    for i, l in enumerate(leads, 1):
        contact = l.get("contact_name") or ("Role inbox" if l.get("role_based") or l.get("title") == "Role inbox" else "—")
        src = l.get("source_url") or ""
        src_cell = f"[link]({src})" if src else "—"
        rows.append("| " + " | ".join([
            str(i),
            _md_cell(l.get("institution")),
            _md_cell(contact),
            _md_cell(l.get("title")),
            _md_cell(l.get("email")),
            _md_cell(l.get("phone")),
            _md_cell(l.get("verification_status")),
            _md_cell(l.get("fit_score")),
            src_cell,
        ]) + " |")

    return "\n".join(fm + rows) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("verified", help="Path to the verified batch JSON")
    ap.add_argument("--out", help="Output markdown path (default: vault/leads/leadbooks/<stem>-leadbook.md)")
    args = ap.parse_args()

    src = Path(args.verified).expanduser().resolve()
    leads, wrapper = load_leads(src)
    md = build_leadbook(leads, wrapper, src)

    stem = src.stem
    if stem.endswith("-verified"):
        stem = stem[: -len("-verified")]
    out = Path(args.out).expanduser() if args.out else (LEADBOOKS_DIR / f"{stem}-leadbook.md")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md, encoding="utf-8")
    print(json.dumps({"leadbook": str(out), "verified_count": len(leads)}, indent=2))


if __name__ == "__main__":
    main()
