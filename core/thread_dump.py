#!/usr/bin/env python3
"""thread_dump.py — the FULL conversation with a company, from the corpus shards.

The cockpit's thread pane (parity/redesign rebuild 2026-07-03). Reads the SAME
substrate as truth.py (corpus_store shards — zero IMAP, ~ms), keys by the SAME
identity.company_key, and returns every message both directions in date order
with full bodies (quoted history stripped).

Fork-proof BY CONSTRUCTION (thread-fork audit 2026-07-03, the Beta case):
Gmail THRIDs fork when a reply anchors onto a Google Calendar notification —
grouping by company + date instead of THRID renders the conversation whole no
matter how Gmail split it. Calendar notices (mid <calendar-*@google.com>,
"Aceptada:/Invitación:/Rechazada:" subjects) are TAGGED, not hidden, so the
operator sees them as system events rather than prose.

READ-ONLY. Usage: thread_dump.py --key <company-key> [--max 60] [--chars 4000]
Output: one JSON object on stdout.
"""
import argparse, json, re, sys, html as _html
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import identity as ident

TOOLS = Path("/opt/velab/workspace/tools")
sys.path.insert(0, str(TOOLS))
import corpus_store  # noqa: E402

# ---- body extraction (mirrors truth.py — same text for the same message) ----
_HTML_DROP = re.compile(r"(?is)<(script|style|head)\b.*?</\1>")
_HTML_BR = re.compile(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>")
_HTML_TAG = re.compile(r"<[^>]+>")

def html_to_text(h):
    if not h:
        return ""
    h = _HTML_DROP.sub(" ", h)
    h = _HTML_BR.sub("\n", h)
    t = _html.unescape(_HTML_TAG.sub("", h))
    return re.sub(r"\n\s*\n+", "\n\n", t).strip()

def body_of(m):
    return (m.get("text") or html_to_text(m.get("html")) or m.get("snippet") or "")

_QUOTE_CUT = re.compile(
    r"(^>.*$)|(^\s*El .*escribi[oó]:.*$)|(^\s*On .*wrote:.*$)|"
    r"(-----\s*Original Message)|(^_{6,}\s*$)|(^De:\s)|(^From:\s)",
    re.I | re.M)

def strip_quoted(text):
    if not text:
        return ""
    m = _QUOTE_CUT.search(text)
    return (text[:m.start()] if m else text).strip()

# ---- calendar / auto notices (the fork-audit taxonomy) ----------------------
_CAL_MID = re.compile(r"<calendar-[^>]*@google\.com>", re.I)
_CAL_SUBJ = re.compile(
    r"^\s*(aceptada?|accepted|rechazada?|declined|invitaci[oó]n( actualizada)?|"
    r"invitation|updated invitation|cancelad[oa]|cancelled|canceled)\s*:", re.I)
_AUTO = re.compile(r"automatic reply|out of office|respuesta autom|fuera de (la )?oficina|autoreply", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", required=True, help="company key (identity.company_key)")
    ap.add_argument("--max", type=int, default=60, help="max messages (newest kept)")
    ap.add_argument("--chars", type=int, default=4000, help="max body chars per message")
    a = ap.parse_args()
    want = ident.company_key(a.key)

    allmail, sent, newest = corpus_store.load_shards()
    seen, rows = set(), []
    for m in list(allmail) + list(sent):
        mid = m.get("messageId")
        if mid and mid in seen:
            continue
        if mid:
            seen.add(mid)
        fr, to = ident.email_of(m.get("from", "")), ident.email_of(m.get("to", ""))
        inbound = not ident.is_self(fr)
        cp = fr if inbound else to
        if not cp or ident.is_self(cp):
            continue
        if ident.company_key(cp) != want:
            continue
        subj = m.get("subject") or ""
        body = strip_quoted(body_of(m))
        calendar = bool((mid and _CAL_MID.search(mid)) or _CAL_SUBJ.search(subj))
        rows.append({
            "date": (m.get("date") or "")[:16],
            "dir": "in" if inbound else "out",
            "from": fr, "to": to,
            "subject": subj,
            "body": body[:a.chars] + ("…" if len(body) > a.chars else ""),
            "calendar": calendar,
            "auto": bool(_AUTO.search(subj + " " + body[:200])),
            "noise": bool(ident.NOISE_FROM.search(m.get("from") or "")) if inbound else False,
        })
    rows.sort(key=lambda r: r["date"])
    if len(rows) > a.max:
        rows = rows[-a.max:]
    people = sorted({r["from"] for r in rows
                     if r["dir"] == "in" and not r["noise"] and not r["calendar"]})
    print(json.dumps({"key": want, "people": people, "corpus_pulled_at": newest,
                      "count": len(rows), "messages": rows}, ensure_ascii=False))


if __name__ == "__main__":
    main()
