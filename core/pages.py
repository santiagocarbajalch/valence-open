#!/usr/bin/env python3
"""pages.py — humanized company pages + INDEX (blueprint §4, operator mandate).

Renders vault/companies/<key>.md for every engaged company from board.json — pages are
VIEWS of the persisted truth, regenerated after every derive, so the "human layer rotted
while machine truth stayed fresh" failure class is structurally impossible.

Dual audience: YAML frontmatter for machines; plain-language page for the operator.
The `## Operator notes` section is preserved VERBATIM across regenerations — everything
above it is machine-owned and says so.

Run: python3 pages.py          (after truth.py; the derive chain calls both)
"""
import json, re, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import codebook as cb

VAULT = Path("/opt/velab/vault")
BOARD = VAULT / "state/board.json"
PAGES = VAULT / "companies"
NOTES_HEADER = "## Operator notes"

def slug(key):
    return re.sub(r"[^a-z0-9.@-]+", "-", key.lower())

def d(s):
    return (s or "")[:10]

def title_of(c):
    base = c["key"].split("@")[-1] if "@" in c["key"] else c["key"]
    name = base.split(".")[0].replace("-", " ").title()
    return f"{name} ({c['key']})"

def status_line(c):
    if c.get("suppressed"):
        bits = [cb.suppressed_label(c["suppressed"])]
        fm = c.get("frozen_meta") or {}
        if fm.get("reason"):
            bits.append(fm["reason"])
        return " · ".join(bits)
    bits = [cb.bucket_label(c["bucket"]), cb.state_label(c["state"])]
    if c.get("meeting_state"):
        bits.append(cb.meeting_label(c["meeting_state"]) + (f" ({d(c.get('meeting_at'))})" if c.get("meeting_at") else ""))
    if c.get("followup_due"):
        bits.append(f"quiet for {c.get('bizdays_since_out')} business days — nudge or freeze")
    if c.get("deliverables_missing"):
        bits.append("⚠️ asked for " + ", ".join(c["deliverables_missing"]) + " — not sent yet")
    return " · ".join(bits)

def render(c, old_notes):
    v = c.get("verdict") or {}
    kf = c.get("key_facts") or {}
    lines = []
    lines.append("---")
    lines.append(f"key: {c['key']}")
    lines.append(f"class: {c.get('class')}")
    lines.append(f"bucket: {c.get('suppressed') or c.get('bucket')}")
    lines.append(f"state: {c.get('state')}")
    lines.append(f"last_in: {c.get('last_in_date') or ''}")
    lines.append(f"last_out: {c.get('last_out_date') or ''}")
    lines.append(f"regenerated: {datetime.now(timezone.utc).isoformat()}")
    lines.append("owner: truth-engine (everything above 'Operator notes' is regenerated — do not hand-edit)")
    lines.append("---")
    lines.append("")
    lines.append(f"# {title_of(c)}")
    lines.append("")
    lines.append(f"**{status_line(c)}**")
    lines.append("")
    if v.get("summary"):
        lines.append("## Where it stands")
        lines.append(v["summary"].strip())
        lines.append("")
    na = v.get("next_action")
    if na:
        lines.append(f"**Next action:** {na.strip()}")
        lines.append("")
    facts = []
    if kf.get("models_cited"):
        facts.append("Models they cited: " + ", ".join(kf["models_cited"]))
    if kf.get("figures_cited"):
        facts.append("Figures mentioned: " + ", ".join(kf["figures_cited"]))
    if kf.get("doc_sent"):
        facts.append("We sent: " + ", ".join(kf["doc_sent"]))
    if c.get("people"):
        facts.append("People: " + ", ".join(c["people"]))
    if facts:
        lines.append("## Key facts")
        for f in facts:
            lines.append(f"- {f}")
        lines.append("")
    thr = [t for t in (c.get("threads") or []) if t.get("last_in") or t.get("last_out")]
    if len(thr) > 1:
        lines.append("## Conversations")
        for t in thr:
            last = max((t.get("last_in") or {}).get("date", ""), (t.get("last_out") or {}).get("date", ""))
            flag = " ⚠️ " + ", ".join(t["missing"]) + " not sent" if t.get("missing") else ""
            lines.append(f"- **{t['subject'][:60]}** — last activity {d(last)}{flag}")
        lines.append("")
    ev = c.get("events") or []
    if ev:
        lines.append("## Timeline")
        for e in ev[:14]:
            who = "us" if e["dir"] == "out" else ("📝 " + (e.get("who") or "note") if e["dir"] == "note" else e.get("who") or "them")
            g = (e.get("gist") or "").strip()
            if g:
                lines.append(f"- {d(e['date'])} — **{who}**: {g[:160]}")
        lines.append("")
    lines.append(NOTES_HEADER)
    lines.append(old_notes if old_notes else "_(yours — never overwritten by regeneration)_")
    lines.append("")
    return "\n".join(lines)

def extract_notes(path):
    try:
        txt = path.read_text()
    except Exception:
        return None
    i = txt.find(NOTES_HEADER)
    if i < 0:
        return None
    body = txt[i + len(NOTES_HEADER):].strip()
    return body if body and "never overwritten by regeneration" not in body else None

def main():
    board = json.loads(BOARD.read_text())
    PAGES.mkdir(parents=True, exist_ok=True)
    live = [c for c in board.get("companies", []) if c.get("last_in_date")]
    hist = board.get("suppressed_engaged", [])
    written, sections = 0, {}
    for c in live + hist:
        p = PAGES / f"{slug(c['key'])}.md"
        page = render(c, extract_notes(p))
        p.write_text(page)
        written += 1
        sections.setdefault(c.get("suppressed") or c["bucket"], []).append(c)

    # INDEX — one line per company, grouped, plain language
    idx = ["# Companies — where everything stands",
           f"_Regenerated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} from the certified board. One page per company; your notes live under 'Operator notes' on each page._",
           ""]
    order = ["owe", "owe-review", "awaiting", "institutional", "frozen", "closed"]
    for b in order:
        rows = sections.get(b) or []
        if not rows:
            continue
        idx.append(f"## {cb.bucket_label(b) if b in cb.BUCKET else cb.suppressed_label(b)} ({len(rows)})")
        for c in sorted(rows, key=lambda x: x.get("last_in_date") or "", reverse=True):
            gist = (c.get("last_in_gist") or c.get("last_out_gist") or "")[:80]
            idx.append(f"- [{title_of(c)}]({slug(c['key'])}.md) — {d(c.get('last_in_date')) or 'no reply'} · {cb.state_label(c.get('state'))}" + (f" — “{gist}”" if gist else ""))
        idx.append("")
    (PAGES / "INDEX.md").write_text("\n".join(idx))
    print(f"pages: {written} written · INDEX with {sum(len(v) for v in sections.values())} rows")

if __name__ == "__main__":
    main()
