#!/usr/bin/env python3
"""render_board.py — THE canonical view of vault/state/board.json, for EVERY surface.

Rebuilt 2026-07-03 (parity rebuild): /inbox-check prints render_markdown(); the
valence-console cockpit consumes `--json` (build_view()) and renders the SAME
sections, SAME row cells, SAME action strings. All presentation classification
lives HERE — neither surface re-derives buckets, staleness, or action text, so
the two can never drift again (the format-drift + stale-verdict audit class).

  ✅/❌ cert line(s)
  📅 MEETINGS strip        — upcoming/rescheduling/outcome-due; the ONE allowed duplication
  🔴 REPLY NEEDED          — they wrote last, unanswered (owe + owe-review)
  🔔 NUDGE DUE             — cadence floor reached (in-flight 2bd / promised 5bd)
  ⏳ IN-FLIGHT             — awaiting, not yet due
  🔴 COLD                  — tally + the DUE companies as rows (exhausted stay
                             behind --freeze-proposals; their action is a freeze call)
  🏛️ INSTITUTIONAL         — parked, never nudged, never frozen
  🟠 PROPOSED CLOSES       — operator-gated
  🧊 FROZEN                — count line (rows with --frozen / in the JSON view)
  📊 SNAPSHOT

One row per company below the strip — precedence REPLY > NUDGE > IN-FLIGHT.
Action text is derived from engine state ONLY; verdict.next_action appears
only when the ENGINE's stale flag is false, labeled as the Archivist's.
Operator notes render FULL under their row (full-granularity verdict
2026-07-09); the 📝N header marker stays as the count.
READ-ONLY. Flags: --json (the cockpit view) · --frozen (markdown frozen rows) ·
--digest (compact four-field operator digest — the /inbox-check default since
the 2026-07-13 legibility call; bullet one-liners since the 2026-07-16 format
interview: lead+contact · them/us snippet · last-nudge date · no-reply count;
the full ledger below stays the drill-down surface).

Markdown legibility (operator calls 2026-07-09): every markdown line is
pre-wrapped at WRAP=64 cols — continuation lines keep the │ gutter — and
section headers are bold-divided (`### **LABEL** (n)` + plain descriptor
line). Markdown serialization only; the --json view strings are untouched.

FULL-GRANULARITY LEDGER (operator verdict 2026-07-09, after the five-auditor
sweep measured 66% of every fresh Archivist advisory amputated by clip(),
notes reduced to a count, touches rendered nowhere, and 65 cold-due rows
collapsed to a tally): every row now carries a cadence line (sent/replies/
quiet/next-due), both gists full, promises and freeze/hold reasons full,
notes full, and the advisory unclipped. Never under-tell.
"""
import argparse, json, sys, textwrap
from datetime import datetime, timezone
from pathlib import Path

BOARD = Path("/opt/velab/vault/state/board.json")
LAST_FULL = BOARD.parent / "last_full_cert.json"
AUDIT = BOARD.parent / "audit.json"


def load_audit():
    """The Auditor's cross-plane verdict (auditor.py). Surfaced at the top of the
    digest and in the console view so a data-integrity failure can never sit
    silent the way integrity.py did (failed 10h unnoticed, 2026-07-14)."""
    try:
        return json.loads(AUDIT.read_text())
    except Exception:
        return None

DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# COLUMNS names the canonical cell keys for the JSON view (cockpit). The markdown
# serialization is LEDGER BLOCKS (operator-chosen 2026-07-07) — no tables.
COLUMNS = ["Company", "Who", "Last in", "Their ask / situation", "Our last reply", "Action"]


def dshort(iso):
    """'2026-07-01T16:35' -> 'Jul 1 2026' (year always shown — full-granularity
    operator call 2026-07-09: dates must never under-tell)."""
    if not iso:
        return "—"
    try:
        d = datetime.fromisoformat(iso[:10])
        return f"{MON[d.month]} {d.day} {d.year}"
    except Exception:
        return iso[:10]


def dmeet(iso):
    try:
        d = datetime.fromisoformat(iso[:10])
        return f"{DOW[d.weekday()]} {MON[d.month]} {d.day}"
    except Exception:
        return iso or "?"


def dnud(iso, today_year):
    """Digest date: 'Jul 8' — year appended ONLY when it differs from the board's
    today (digest is a scan surface, operator format call 2026-07-13; the full
    ledger keeps always-year dshort per the 2026-07-09 never-under-tell rule)."""
    if not iso:
        return "—"
    try:
        d = datetime.fromisoformat(iso[:10])
        return f"{MON[d.month]} {d.day}" + (f" {d.year}" if d.year != today_year else "")
    except Exception:
        return iso[:10]


def unanswered_streak(c, ball):
    """How many consecutive messages the ball-holder has sent since the OTHER
    side last responded — i.e. 'how many have gone out without a reply'
    (operator standardized-format field 2026-07-16). ball='us' → trailing
    outbound run (our unanswered nudges); ball='them' → trailing inbound run
    (their messages we still owe). For a cold lead (no inbound ever) this equals
    the touch count. Derived from engine events only — never re-derived truth."""
    want = "in" if ball == "them" else "out"
    evs = sorted((e for e in (c.get("events") or []) if e.get("date")),
                 key=lambda e: e.get("date") or "")
    n = 0
    for e in reversed(evs):
        if e.get("dir") == want:
            n += 1
        else:
            break
    # cold ladders: events can be capped; the persisted touch count is canonical
    if ball == "us" and c.get("cold_substate"):
        n = max(n, c.get("touches") or 0)
    return n


# Markdown pre-wrap width (operator call 2026-07-09): long ledger lines wrapped
# raggedly at the terminal edge, continuations losing the │ gutter — illegible on
# anything narrower than fullscreen. Every markdown line is pre-wrapped here so
# the block shape survives any terminal ≥ WRAP cols. Markdown-only; --json untouched.
WRAP = 64


def mdwrap(line, cont=None):
    """Pre-wrap one physical line at WRAP cols on word boundaries. Continuation
    lines keep the │ gutter (or a 2-space hang for non-gutter lines) so wrapped
    text still reads as part of its block. Bold spans never contain spaces in
    row content (company keys), so wraps can't split a ** span."""
    if len(line) <= WRAP:
        return [line]
    if cont is None:
        cont = "│   " if line.startswith(("│", "─")) else "  "
    return textwrap.wrap(line, width=WRAP, subsequent_indent=cont,
                         break_long_words=False, break_on_hyphens=False)


def sec_header(title, n=None):
    """Section heading, bold-divided (operator call 2026-07-09: rely on bolding
    to divide sections/titles). The label before ' — ' goes bold on the heading
    line; the descriptor drops to a plain line below so the heading never wraps."""
    label, _, desc = title.partition(" — ")
    lines = [f"### **{label}**" + (f" ({n})" if n is not None else "")]
    if desc:
        lines += [ln + "  " for ln in mdwrap(desc, cont="  ")]
    return lines


def clip(s, n=110):
    s = (s or "").replace("|", "¦").replace("\n", " ").strip()
    if len(s) <= n:
        return s
    cut = s[:n - 1]
    if " " in cut:  # truncate on a word boundary, never mid-word
        cut = cut[:cut.rfind(" ")]
    return cut.rstrip() + "…"


def engine_parts(c):
    """Deterministic action parts from engine state — no prose invention."""
    st, parts = c.get("state") or "", []
    missing = c.get("deliverables_missing") or []
    # spam-folder findings first (audit 2026-07-09) — data-honesty items, loud:
    if c.get("bounces"):
        b = c["bounces"][-1]
        parts.append(f"⚠️ send BOUNCED {dshort(b.get('date'))} ({b.get('to')}) — never arrived, verify address")
    if c.get("spam_inbound"):
        parts.append("⚠️ their mail landed in Gmail Spam — folded here, check the spam folder")
    if c.get("meeting_state") == "scheduled" and c.get("meeting_invite_sent") is False:
        parts.append(f"⚠️ send calendar invite for {dmeet(c.get('meeting_at'))}")
    if c.get("meeting_state") == "rescheduling":
        parts.append("⚠️ meeting in limbo — propose new date")
    if missing:
        parts.append(f"⚠️ send owed: {', '.join(missing)}")
    base = {
        "question": "answer their question",
        "info-request": "send the requested info",
        "meeting-request": "propose meeting slots",
        "meeting-outcome-due": "meeting passed in silence — log outcome / follow up",
        "undelivered-ask": "deliver what they asked for",
        "declined-but-open": "acknowledge decline, keep door open",
        "opening": "reply to their interest",
        "replied-unclassified": "read thread & decide",
    }.get(st)
    if base:
        parts.append(base)
    if c.get("followup_due"):
        parts.append(f"nudge or freeze ({c.get('bizdays_since_out')}bd quiet)")
    return parts


def archivist_part(c):
    """The Archivist's advisory line — only when the engine says it isn't stale.
    FULL text (was clip@90 — the granularity audit 2026-07-09 measured 66% of
    every fresh advisory amputated mid-sentence); clip() here only sanitizes."""
    v = c.get("verdict") or {}
    if v.get("next_action") and not v.get("stale"):
        return clip(v["next_action"], 4000)
    return None


def action_for(c):
    """The flat Action string — engine parts, then the labeled Archivist advisory."""
    parts = list(engine_parts(c))
    na = archivist_part(c)
    if na:
        parts.append(f"Archivist: {na}")
    return "; ".join(parts) or "—"


def row_cells(c, action=None):
    """The six canonical cell strings — the ONLY row format either surface shows.
    Gists render FULL (engine caps them at ~280; the old clip@110/80 stacked a
    clip on a clip — granularity audit 2026-07-09)."""
    who = c.get("last_in_from") or "—"
    li = f"{dshort(c.get('last_in_date'))}"
    ask = clip(c.get("last_in_gist") or "—", 400)
    lo_g = c.get("last_out_gist")
    lo = f"{dshort(c.get('last_out_date'))} — {clip(lo_g, 400)}" if lo_g else "— none"
    missing = c.get("deliverables_missing") or []
    if missing:
        lo += f" ⚠️ asked for {', '.join(missing)}, not sent"
    mt = ""
    if c.get("meeting_state") in ("scheduled", "outcome-due", "rescheduling"):
        mt = f" 📅{c.get('meeting_state')}"
        if c.get("meeting_at"):
            mt += f" {dmeet(c['meeting_at'])}"
    act = action or action_for(c)
    n_notes = len(c.get("notes") or [])
    if n_notes:
        act += f" · 📝{n_notes}"
    return {"company": f"{c.get('key') or ''}{mt}", "who": who, "last_in": li,
            "ask": ask, "last_out": lo, "action": act}


def row_meta(c):
    """Machine layer the cockpit needs for its dossier + actions (no new strings)."""
    return {
        "bucket": c.get("bucket"), "state": c.get("state"),
        "people": c.get("people") or [],
        "last_in_date": c.get("last_in_date"), "last_in_from": c.get("last_in_from"),
        "last_in_subj": c.get("last_in_subj"), "last_in_gist": c.get("last_in_gist"),
        "last_out_date": c.get("last_out_date"), "last_out_gist": c.get("last_out_gist"),
        "bizdays_since_out": c.get("bizdays_since_out"), "touches": c.get("touches"),
        "replies_count": c.get("replies_count"), "next_due": c.get("next_due"),
        "bounces": c.get("bounces"), "spam_inbound": bool(c.get("spam_inbound")),
        "frozen_meta": c.get("frozen_meta"),
        "signals": c.get("signals") or [],
        "deliverables_missing": c.get("deliverables_missing") or [],
        "followup_due": bool(c.get("followup_due")), "them_last": bool(c.get("them_last")),
        "meeting_at": c.get("meeting_at"), "meeting_state": c.get("meeting_state"),
        "meeting_invite_sent": c.get("meeting_invite_sent"),
        "meeting_source": c.get("meeting_source"),
        "meeting_meet_url": c.get("meeting_meet_url"),
        "meeting_event_id": c.get("meeting_event_id"),
        "company_class": c.get("class"),
        "notes": (c.get("notes") or [])[:5], "key_facts": c.get("key_facts"),
        "verdict": c.get("verdict"), "suppressed": c.get("suppressed"),
        "hold_until": c.get("hold_until"), "hold_reason": c.get("hold_reason"),
        "personal": bool(c.get("personal")), "personal_reason": c.get("personal_reason"),
    }


def vrow(c, action=None):
    # action_parts = the SAME content as cells.action, kept structured so a
    # surface can render provenance (engine verdict vs Archivist advisory vs
    # operator notes) distinctly. cells.action stays the canonical flat string
    # (markdown serialization); the parts are never allowed to say more.
    # 2026-07-09 symmetry fix (agent-health audit): the advisory used to be
    # nulled on override rows while archivist_stale still rendered — so "no tag"
    # silently meant "fresh verdict, hidden". The advisory is now ALWAYS carried
    # (override rows render it as a subordinate line, never as the action) and
    # the fresh/STALE tags derive from the same source on every section.
    override = action is not None
    eng = [action] if override else engine_parts(c)
    arch = archivist_part(c)
    v = c.get("verdict") or {}
    parts = {"engine": eng, "archivist": arch,
             "archivist_stale": bool(v.get("stale")),
             "override": override,
             "notes": len(c.get("notes") or [])}
    # keep the flat cell string a faithful superset of the parts on override rows
    flat = f"{action} · Archivist (advisory): {arch}" if (override and arch) else action
    return {"key": c.get("key"), "cells": row_cells(c, flat), "meta": row_meta(c),
            "action_parts": parts}


def digest_row(c):
    """One digest row (operator format call 2026-07-13): who holds the ball
    (engine them_last — never re-derived), the last message snippet from that
    side, and the outbound-touch ledger (dates of every send, from events).
    Derives ONLY from engine fields already in the view's rows — the digest can
    never say more than the ledger, only less."""
    them = bool(c.get("them_last")) or not c.get("last_out_date")
    ball = "them" if them else "us"
    if them:
        who = (c.get("last_in_from") or "").split("@")[0] or "them"
        last = {"ball": "them", "who": who,
                "date": c.get("last_in_date"), "gist": c.get("last_in_gist")}
    else:
        last = {"ball": "us", "who": "us",
                "date": c.get("last_out_date"), "gist": c.get("last_out_gist")}
    # contact = the lead's person (operator four-field format 2026-07-16):
    # who wrote last when they hold the ball, else who we've been writing to.
    # Engine fields only (last_in_from / people[0]) — display names don't exist
    # in the corpus index, so the mailbox localpart IS the deterministic name.
    caddr = (c.get("last_in_from") if them else None) or \
            ((c.get("people") or [None])[0])
    contact = f"{caddr.split('@')[0]}@" if caddr and caddr != c.get("key") else ""
    outs = sorted({(e.get("date") or "")[:10]
                   for e in (c.get("events") or []) if e.get("dir") == "out"})
    return {"key": c.get("key"), "last": last, "out_dates": outs,
            "contact": contact,
            "ball": ball,
            # operator standardized-format field 2026-07-16: consecutive messages
            # from the ball-holder with no reply back — rendered explicitly so it
            # never has to be counted off the date ledger by eye.
            "unanswered": unanswered_streak(c, ball),
            "never_written": not c.get("last_out_date"),
            # cold-lead fields (present only on cold-due rows so the digest's cold
            # section can carry the SAME standardized row shape as every other
            # section — snippet + who + count — not a divergent 4-col table)
            "cold": bool(c.get("cold_substate")),
            "touches": c.get("touches") or 0,
            "bizdays_since_out": c.get("bizdays_since_out"),
            "hold_until": c.get("hold_until"), "next_due": c.get("next_due"),
            "held": bool(c.get("hold_until")),
            "bounced": bool(c.get("bounces")), "notes": len(c.get("notes") or [])}


def cold_row(c):
    people = c.get("people") or []
    return {"key": c.get("key"), "contact": people[0] if people else "",
            "people": people, "touches": c.get("touches") or 0,
            "cold_substate": c.get("cold_substate"),
            "last_out_date": c.get("last_out_date"),
            "bizdays_since_out": c.get("bizdays_since_out"),
            "next_due": c.get("next_due"), "bounces": c.get("bounces")}


def build_view(b):
    """The canonical view. Markdown is a serialization of THIS; the cockpit renders THIS."""
    meta, cert = b.get("meta", {}), b.get("cert") or {}
    comps = b.get("companies", [])
    counts = meta.get("counts", {})

    # ---- cert lines, exactly as printed
    if cert.get("certified"):
        cert_lines = [f"✅ **CERTIFIED** ({cert.get('mode')}) — {cert.get('independent_msgs')} msgs read "
                      f"independently, {cert.get('companies_checked')} companies cross-checked · "
                      f"{(cert.get('checked_at') or '')[:16]}Z"]
    else:
        cert_lines = [f"❌ **NOT CERTIFIED** — {'; '.join(cert.get('fails') or ['no cert block'])}"]
    cert_lines += [f"⚠️ {w}" for w in cert.get("warns") or []]
    # quick cert is circular (board shards vs board) — always show the age of the
    # last DEEP check (--full = live Gmail pull; the 2026-07-07 phantom-send audit)
    if not (cert.get("mode") or "").startswith("full"):
        try:
            lf = json.loads(LAST_FULL.read_text())
            age_h = (datetime.now(timezone.utc)
                     - datetime.fromisoformat(lf["at"])).total_seconds() / 3600
            mark = "✅" if lf.get("certified") else "❌ FAILED"
            line = f"{mark} last FULL cert {lf['at'][:16]}Z ({age_h:.0f}h ago)"
            if age_h > 26:
                line += " · ⚠️ STALE — run certify.py --full"
            cert_lines.append(line)
        except Exception:
            cert_lines.append("⚠️ no FULL cert on record — run certify.py --full once")

    live = [c for c in comps if c.get("bucket") != "cold"]
    cold = [c for c in comps if c.get("bucket") == "cold"]

    # ---- 📅 meetings strip (the one allowed duplication)
    strip = [c for c in live if c.get("meeting_state") in ("scheduled", "rescheduling", "outcome-due")]
    strip.sort(key=lambda c: c.get("meeting_at") or "9999")
    meetings = []
    for c in strip:
        st, key = c["meeting_state"], c.get("key") or ""
        if st == "scheduled":
            inv = "invite sent ✓" if c.get("meeting_invite_sent") else "⚠️ INVITE NOT SENT"
            line = f"- **{dmeet(c['meeting_at'])}** — {key} ({inv})"
        elif st == "rescheduling":
            line = f"- **rescheduling** — {key} (old date void, new one pending)"
        else:
            line = f"- **{dmeet(c['meeting_at'])} passed in silence** — {key} (log outcome)"
        # structured fields alongside the terminal line — the cockpit renders
        # date/company/status/Meet-link as real affordances, never the raw line
        meetings.append({"key": key, "state": st, "line": line,
                         "at": c.get("meeting_at"),
                         "invite_sent": c.get("meeting_invite_sent"),
                         "meet_url": c.get("meeting_meet_url"),
                         "event_id": c.get("meeting_event_id")})

    # ---- one row per company: REPLY > CLOSE-OUT > NUDGE > IN-FLIGHT (inst separate).
    # V4.1 Phase 4: the sections are a DISJOINT partition. An owed reply beats a
    # close suggestion outright (the row stays in REPLY, leaves the close list);
    # otherwise a dead-lead suggestion beats nudging/waiting on a dead lead — the
    # same company can never sit in "waiting on them" AND "suggested close-outs".
    # first-contact senders (we never emailed them) — their own review lane
    # (operator ruling 2026-07-11); pulled out FIRST so they can't leak into
    # the awaiting/in-flight partitions, which all assume an outbound exists.
    contacted = [c for c in live if c.get("bucket") == "inbound_only"]
    live = [c for c in live if c.get("bucket") != "inbound_only"]
    inst = [c for c in live if c.get("bucket") == "institutional"]
    rest = [c for c in live if c.get("bucket") != "institutional"]
    # V4.2 operator directives OUTRANK engine sectioning (buckets underneath stay
    # true — the directive is presentation, honored identically on both surfaces):
    #   personal — operator-owned deal, automation off, own strip
    #   held     — leaves the worklist until hold_until, then resurfaces by itself
    personal = [c for c in rest if c.get("personal")]
    rest = [c for c in rest if not c.get("personal")]
    held = [c for c in rest if c.get("hold_until")]
    rest = [c for c in rest if not c.get("hold_until")]
    reply = [c for c in rest if c.get("bucket") in ("owe", "owe-review")]
    reply_keys = {c.get("key") for c in reply}
    closes = [p for p in (meta.get("proposed_closes") or []) if p.get("key") not in reply_keys]
    close_keys = {p.get("key") for p in closes}
    closeout = [c for c in rest if c not in reply and c.get("key") in close_keys]
    nudge = [c for c in rest if c not in reply and c.get("key") not in close_keys and c.get("followup_due")]
    flight = [c for c in rest if c not in reply and c.get("key") not in close_keys and c not in nudge]

    sections = []
    if True:  # sections are always present in the view; markdown skips empty ones
        sections.append({"id": "reply",
                         "title": "🔴 REPLY NEEDED — they wrote last, unanswered",
                         "rows": [vrow(c) for c in sorted(reply, key=lambda c: c.get("last_in_date") or "")]})
        sections.append({"id": "contacted",
                         "title": "📨 THEY CONTACTED US FIRST — never emailed by us; reply, or close out as junk",
                         "rows": [vrow(c, action="first contact — read it, then reply or close out")
                                  for c in sorted(contacted, key=lambda c: c.get("last_in_date") or "", reverse=True)]})
        sections.append({"id": "personal",
                         "title": "🤝 IN YOUR HANDS — operator-owned, automation off",
                         "rows": [vrow(c, action=f"yours — {clip(c.get('personal_reason'), 400)}"
                                       if c.get("personal_reason") else "yours — automation off")
                                  for c in sorted(personal, key=lambda c: c.get("last_in_date") or "", reverse=True)]})
        sections.append({"id": "held",
                         "title": "⏸ HELD — operator holds, back on their date",
                         "rows": [vrow(c, action=f"held until {c.get('hold_until')} (operator)"
                                       + (f" — {clip(c.get('hold_reason'), 400)}" if c.get("hold_reason") else ""))
                                  for c in sorted(held, key=lambda c: c.get("hold_until") or "")]})
        sections.append({"id": "nudge",
                         "title": "🔔 NUDGE DUE — cadence floor reached (in-flight 2bd · promised-revert 5bd)",
                         "rows": [vrow(c) for c in sorted(nudge, key=lambda c: -(c.get("bizdays_since_out") or 0))]})
        sections.append({"id": "closeout",
                         "title": "PROPOSED CLOSE-OUTS — the engine reads these as dead (operator-gated)",
                         "rows": [vrow(c, action="close-out suggested") for c in
                                  sorted(closeout, key=lambda c: c.get("last_in_date") or "")]})
        sections.append({"id": "inflight",
                         "title": "⏳ IN-FLIGHT — awaiting them, not yet due",
                         "rows": [vrow(c, action="wait") for c in
                                  sorted(flight, key=lambda c: c.get("last_out_date") or "", reverse=True)]})
        sections.append({"id": "institutional",
                         "title": "🏛️ INSTITUTIONAL → Licitador — parked, never nudged, never frozen",
                         "rows": [vrow(c, action="parked (Licitador lane)") for c in
                                  sorted(inst, key=lambda c: c.get("last_in_date") or "")]})

    cold_line = (f"### 🔴 COLD worklist — {counts.get('cold_due', 0)} genuinely due · "
                 f"{counts.get('cold_exhausted', 0)} cadence-exhausted (→ freeze proposals, not nudged) · "
                 f"{counts.get('cold_not_due', 0)} not yet due · "
                 f"{counts.get('cold_dead', 0)} dead address (bounced/do-not-contact — never emailed)")

    close_items = [{"key": p.get("key"), "who": p.get("who"), "reason": p.get("reason"),
                    "whose_turn": p.get("whose_turn"), "reason_kind": p.get("reason_kind"),
                    "evidence_quote": p.get("evidence_quote") or p.get("their_last"),
                    "last_in_date": p.get("last_in_date"), "last_out_date": p.get("last_out_date"),
                    "line": f"- **{p.get('key')}** ({p.get('who')}): {clip(p.get('reason'), 1000)}"}
                   for p in closes]

    frozen_line = f"🧊 Frozen: {counts.get('frozen', 0)} (count only)"
    frozen_rows = [vrow(c, action=(c.get("suppressed") or "frozen"))
                   for c in sorted(b.get("suppressed_engaged") or [],
                                   key=lambda c: c.get("last_in_date") or "", reverse=True)]

    n_reply, n_nudge, n_flight, n_inst = len(reply), len(nudge), len(flight), len(inst)
    # 'test' dropped 2026-07-08: truth.py deliberately does NOT suppress test
    # identities (operator ruling 2026-07-04), so counts['test'] could never be
    # populated — the counter printed a dead 'test 0' forever (audit finding).
    # inbound_only left the suppressed tally 2026-07-11 — those rows are now
    # VISIBLE (the 'contacted' lane), and a visible row may not be called suppressed
    supp = " · ".join(f"{k} {counts.get(k, 0)}" for k in
                      ("spam", "system", "dnc", "probe", "closed"))
    snapshot = [
        f"### 📊 Snapshot — {meta.get('actionable')} actionable / {meta.get('companies_total')} companies",
        f"reply {n_reply} · first-contact {len(contacted)} · in your hands {len(personal)} · held {len(held)} · nudge-due {n_nudge} · "
        f"in-flight {n_flight} · institutional {n_inst} · cold {counts.get('cold', 0)} · suppressed: {supp}",
        f"engine {meta.get('engine')} · board {(meta.get('as_of') or '')[:16]}Z · "
        f"corpus age {meta.get('corpus_age_min')}m · cert {cert.get('mode')} {(cert.get('checked_at') or '')[:16]}Z",
    ]

    # ---- compact digest (operator format call 2026-07-13): the same partition,
    # one four-field row per live company (lead+contact · last-message snippet ·
    # last nudge date · no-reply count — 2026-07-16 v3 format interview; the
    # markdown serialization is bullet one-liners, no tables). Cold-DUE
    # companies keep their own section (2026-07-16 — they were amputated to the
    # REST tally and the operator couldn't see the worklist); exhausted/dead/
    # institutional/closes/frozen stay on the ONE REST line. Additive to the
    # view (schema unchanged); markdown --digest serializes THIS.
    hdr = (f"✅ CERTIFIED ({cert.get('mode')}) · {(cert.get('checked_at') or '')[:16]}Z · "
           f"{meta.get('actionable')} actionable / {meta.get('companies_total')}")
    wake = lambda c: c.get("hold_until") or c.get("next_due") or "9999"
    # operator_frozen_pinged — a suppressed lead (frozen/closed/dnc) that wrote
    # back after its freeze with a live signal. The freeze stays on (these rows
    # are NOT in `companies`), but the reply is surfaced LOUD at the top of the
    # digest so it can never sit invisible again (the acme-labs.example.com class).
    pinged_src = b.get("operator_frozen_pinged") or []
    pinged_rows = [vrow(c, action=f"FROZEN LEAD WROTE BACK — {c.get('pinged_reason') or 'review'} "
                                  f"(unfreeze to work it, or re-freeze)")
                   for c in pinged_src]
    def _pdigest(c):
        r = digest_row(c)
        r["pinged_reason"] = c.get("pinged_reason")
        return r
    pinged_digest = [_pdigest(c) for c in pinged_src]
    digest = {
        "header": hdr,
        "sections": [
            {"id": "pinged", "title": "⚠️ FROZEN LEAD WROTE BACK — review (freeze still on)",
             "rows": pinged_digest},
            {"id": "reply", "title": "NEED REPLY",
             "rows": [digest_row(c) for c in sorted(reply, key=lambda c: c.get("last_in_date") or "")]
                     + [digest_row(c) for c in sorted(contacted, key=lambda c: c.get("last_in_date") or "", reverse=True)]},
            {"id": "yours", "title": "YOURS PERSONALLY",
             "rows": [digest_row(c) for c in sorted(personal, key=lambda c: c.get("last_in_date") or "", reverse=True)]},
            {"id": "followup", "title": "FOLLOW-UP DUE",
             "rows": [digest_row(c) for c in sorted(nudge, key=lambda c: -(c.get("bizdays_since_out") or 0))]},
            {"id": "inflight", "title": "IN FLIGHT",
             "rows": [digest_row(c) for c in sorted(flight + held, key=wake)]},
        ],
        # cold-DUE rows for the digest's cold section (2026-07-16). Now FULL
        # digest rows (same shape as every other section — snippet + who +
        # unanswered count), so the cold worklist is in the ONE standardized
        # format, not a divergent 4-col table (operator format call 2026-07-16 v2).
        "cold_due": [digest_row(c) for c in sorted(
            (c for c in cold if c.get("cold_substate") == "due"),
            key=lambda x: -(x.get("bizdays_since_out") or 0))],
        "rest": (f"cold exhausted {counts.get('cold_exhausted', 0)} "
                 f"(freeze candidates) · dead address {counts.get('cold_dead', 0)} (bounced/DNC — not emailed) · "
                 f"institutional {len(inst)} (Licitador) · "
                 f"proposed closes {len(close_items)} · frozen {counts.get('frozen', 0)}"
                 + ("" if meetings else " · meetings: none")),
    }

    return {
        "schema": "board-view v2",  # v2: rows carry action_parts (additive)
        "certified": bool(cert.get("certified")),
        "cert": {"certified": bool(cert.get("certified")), "mode": cert.get("mode"),
                 "checked_at": cert.get("checked_at"), "lines": cert_lines},
        "columns": COLUMNS,
        "meetings": meetings,
        "sections": sections,
        "cold_line": cold_line,
        "proposed_closes": {"title": "🟠 PROPOSED CLOSES — operator-gated (`close_company.py`)",
                            "items": close_items},
        "frozen_line": frozen_line,
        "frozen_rows": frozen_rows,
        "pinged_rows": pinged_rows,
        "audit": load_audit(),
        "digest": digest,
        "snapshot": snapshot,
        "counts": counts,
        "meta": {"as_of": meta.get("as_of"), "today": meta.get("today"),
                 "engine": meta.get("engine"), "corpus_age_min": meta.get("corpus_age_min"),
                 "degraded": bool(meta.get("degraded")),
                 "actionable": meta.get("actionable"), "companies_total": meta.get("companies_total")},
        "keys": [c.get("key") for c in comps],
        "cold_rows": {"due": [cold_row(c) for c in cold if c.get("cold_substate") == "due"],
                      "exhausted": [cold_row(c) for c in cold if c.get("cold_substate") == "exhausted"],
                      # scheduled-but-not-yet-due — the Pipeline tab renders these as
                      # rows (count = filter); markdown surfaces keep the tally only
                      "not_due": [cold_row(c) for c in cold if c.get("cold_substate") == "not_due"],
                      # dead address: every target DNC'd/bounced — out of the ladder,
                      # kept visible so it's a decision (freeze/close), not a silent drop
                      "dead": [cold_row(c) for c in cold if c.get("cold_substate") == "dead"]},
    }


def ledger_rows(rows):
    """Ledger-block serialization (operator-chosen 2026-07-07, replaces the wide
    tables that wrapped illegibly; FULL-GRANULARITY rebuild 2026-07-09 on operator
    verdict — the never-under-tell doctrine). Per company one block:
      header    — company + in/out dates (with year) + verdict freshness + 📝N
      cadence   — sent/replies counted, quiet bizdays, next-due date
      them      — their last line, full gist
      us        — our last reply, full gist
      debts     — owed deliverables + our unfulfilled promises (full text)
      notes     — every operator note, full text
      action    — engine action; Archivist advisory VISIBLY separate (never
                  merged — the Nova ambiguity); on override rows (held/
                  personal/parked/wait) the advisory renders subordinate.
    Same cells/action_parts the cockpit gets; nothing here says more than the view."""
    out = []
    for r in rows:
        c, p, m = r["cells"], r.get("action_parts") or {}, r.get("meta") or {}
        out_d = dshort(m.get("last_out_date")) if m.get("last_out_date") else "—"
        hdr = f"─ **{c['company']}** · in {c['last_in']} / out {out_d}"
        if p.get("archivist_stale"):
            hdr += " · verdict STALE"
        elif p.get("archivist"):
            hdr += " · fresh"
        if p.get("notes"):
            hdr += f" · 📝{p['notes']}"
        lines = [hdr]
        # cadence line — the literal "nudges counted" (tracked all along, rendered nowhere)
        cad = []
        if m.get("touches") is not None:
            cad.append(f"sent {m['touches']}")
        if m.get("replies_count") is not None:
            cad.append(f"replies {m['replies_count']}")
        if m.get("bizdays_since_out") is not None:
            cad.append(f"quiet {m['bizdays_since_out']}bd")
        if m.get("next_due"):
            cad.append(f"next due {dshort(m['next_due'])}")
        if cad:
            lines.append("│ " + " · ".join(cad))
        lines.append(f"│ them ({c['who']}): “{c['ask']}”")
        lo_g = m.get("last_out_gist")
        if lo_g:
            lines.append(f"│ us ({dshort(m.get('last_out_date'))}): “{clip(lo_g, 400)}”")
        missing = m.get("deliverables_missing") or []
        if missing:
            lines.append(f"│ ⚠️ owed since their ask, never sent: {', '.join(missing)}")
        # OUR unfulfilled promises (Archivist commitments_ours, fresh verdicts only) —
        # surfaced 2026-07-08; unclipped 2026-07-09 (38% of the debt text was cut).
        v = m.get("verdict") or {}
        ours = v.get("commitments_ours") or []
        if ours and not v.get("stale"):
            lines.append(f"│ ⚠️ we promised: {clip('; '.join(ours), 1000)}")
        # frozen provenance (audit 2026-07-09: WHY a company froze was unreachable
        # from every surface — row_meta dropped frozen_meta entirely)
        fm = m.get("frozen_meta") or {}
        if fm.get("reason"):
            frz = f"│ frozen {(fm.get('frozen_on') or '')[:10]}"
            if fm.get("by"):
                frz += f" by {fm['by']}"
            lines.append(f"{frz}: {clip(fm['reason'], 1000)}")
        # operator notes, FULL text (were a bare 📝N count — 6.8 KB of rulings hidden)
        for n in (m.get("notes") or []):
            nd = (n.get("ts") or "")[:10]
            nk = n.get("kind") or "note"
            lines.append(f"│ 📝 {dshort(nd)} ({nk}): {clip(n.get('note'), 1000)}")
        eng, arch = "; ".join(p.get("engine") or []), p.get("archivist")
        if p.get("override"):
            # directive/section action outranks the advisory — advisory renders
            # subordinate, never merged, never a CONFLICT (it was deliberately
            # outranked, not contradicted)
            lines.append(f"│ → {eng or '—'}")
            if arch:
                lines.append(f"│ Archivist (advisory): {arch}")
        elif arch and eng and arch.lstrip().lower().startswith("none"):
            lines.append(f"│ → ⚠️ CONFLICT — engine: {eng} · Archivist: {arch}")
        elif arch and eng:
            lines.append(f"│ → {eng} · Archivist: {arch}")
        elif arch:
            lines.append(f"│ → Archivist: {arch}")
        else:
            lines.append(f"│ → {eng or '—'}")
        # pre-wrap at WRAP cols (continuations keep the │ gutter), then trailing
        # double-space = GFM hard break; blocks survive any terminal ≥ WRAP wide
        out += [seg + "  " for ln in lines for seg in mdwrap(ln)]
    return out


def render_markdown(view, show_frozen=False):
    # markdown-only serialization: WRAP-wrapped lines + bold-divided section
    # headers (operator calls 2026-07-09); the JSON view strings stay verbatim
    out = [seg + "  " for ln in view["cert"]["lines"] for seg in mdwrap(ln, cont="  ")]
    out.append("")

    # PINGED tray first — a frozen/closed/dnc lead that wrote back. Loud, at the
    # top, on every markdown surface (not gated behind --frozen).
    if view.get("pinged_rows"):
        out += sec_header("⚠️ FROZEN LEAD WROTE BACK — review; freeze still on",
                          len(view["pinged_rows"]))
        out += ledger_rows(view["pinged_rows"])
        out.append("")

    if view["meetings"]:
        out += sec_header("📅 Meetings")
        out += [seg for m in view["meetings"] for seg in mdwrap(m["line"], cont="  ")]
        out.append("")

    for sec in view["sections"]:
        if sec["id"] == "institutional":
            continue  # rendered after the cold tally, canon order
        if sec["id"] == "closeout":
            continue  # terminal keeps its PROPOSED CLOSES list; the table is cockpit-only
        if not sec["rows"]:
            continue
        out += sec_header(sec["title"], len(sec["rows"]))
        out += ledger_rows(sec["rows"])
        out.append("")

    out += sec_header(view["cold_line"].lstrip("# ").strip())
    # cold-DUE companies render as real rows (full-granularity operator verdict
    # 2026-07-09 — 65 fully-tracked rows were a one-sentence tally; exhausted
    # rows stay behind --freeze-proposals, their action is a freeze decision)
    for r in sorted(view.get("cold_rows", {}).get("due", []),
                    key=lambda x: (x.get("next_due") or "", x.get("last_out_date") or "")):
        line = (f"- **{r['key']}**"
                + (f" · {r['contact']}" if r.get("contact") else "")
                + f" · touch {(r.get('touches') or 0) + 1} of 3 due"
                + f" · last out {dshort(r.get('last_out_date'))}"
                + f" · quiet {r.get('bizdays_since_out')}bd")
        if r.get("next_due"):
            line += f" · due since {dshort(r['next_due'])}"
        if r.get("bounces"):
            line += " · ⚠️ BOUNCED"
        out += [seg for seg in mdwrap(line, cont="  ")]
    out.append("")

    inst = next(s for s in view["sections"] if s["id"] == "institutional")
    if inst["rows"]:
        out += sec_header(inst["title"], len(inst["rows"]))
        out += ledger_rows(inst["rows"])
        out.append("")

    if view["proposed_closes"]["items"]:
        out += sec_header(view["proposed_closes"]["title"])
        out += [seg for i in view["proposed_closes"]["items"]
                for seg in mdwrap(i["line"], cont="  ")]
        out.append("")

    out.append(view["frozen_line"])
    if show_frozen and view["frozen_rows"]:
        out.append("")
        out += sec_header("🧊 FROZEN / CLOSED — suppressed, history kept (never worked)",
                          len(view["frozen_rows"]))
        out += ledger_rows(view["frozen_rows"])
    out.append("")

    out += sec_header(view["snapshot"][0].lstrip("# ").strip())
    out += [seg + "  " for ln in view["snapshot"][1:] for seg in mdwrap(ln, cont="  ")]
    return "\n".join(out)


def digest_line(r, ty):
    """One digest bullet (operator format call 2026-07-16 v3 — the four-field
    one-liner, replacing the 3-col table after the format interview):
      • key [marks] [· contact@] — them/us <date> “snippet” — nudged <date>
        [· N no reply] [· touch N of 3 | final touch]
    Exactly the operator's four fields — lead+contact, last-message snippet with
    who sent it, date of our last nudge, nudges-sent-without-reply count (only
    when we hold the ball) — plus the two safety marks (⚠ bounced send,
    ⏸→wake-date hold) and, on COLD rows only, the touch-ladder token that says
    what the next GO means. Ledger dates, quiet-days and from-them counts are
    digest-dropped (still in the full ledger / cockpit drill-down). Pre-wrapped
    at WRAP cols, 2-space hang, trailing double-space per physical line so
    markdown keeps the hard breaks."""
    l = r["last"]
    ball = r.get("ball") or l.get("ball")

    lead = r["key"]
    if r.get("held"):
        lead += f" ⏸→{dnud(r.get('hold_until'), ty)}" if r.get("hold_until") else " ⏸"
    if r.get("bounced"):
        lead += " ⚠bounced"
    if r.get("cold"):
        lead += " 🔵"
    if r.get("contact"):
        lead += f" · {r['contact']}"

    msg = f"{l['ball']} {dnud(l.get('date'), ty)} “{clip(l.get('gist'), 110)}”"

    seg = []
    outs = r.get("out_dates") or []
    if r.get("never_written") or not outs:
        seg.append("never written")
    else:
        seg.append(f"nudged {dnud(outs[-1], ty)}")
    n = r.get("unanswered") or 0
    if ball == "us" and n:
        seg.append(f"{n} no reply")
    if r.get("cold"):
        due = (r.get("touches") or 0) + 1
        seg.append("final touch" if due >= 3 else f"touch {due} of 3")
    if r.get("pinged_reason"):
        seg.append(f"⚠ {r['pinged_reason']}")

    line = f"• {lead} — {msg} — {' · '.join(seg)}"
    return "\n".join(x + "  " for x in mdwrap(line, cont="  "))


def render_digest(view):
    """Compact operator digest (format call 2026-07-13, replacing the full
    ledger as the /inbox-check default after the legibility complaint; v3
    2026-07-16 format interview: four-field one-liner BULLETS, no tables): one
    bullet per live company, sections NEED REPLY / YOURS PERSONALLY /
    FOLLOW-UP DUE / IN FLIGHT / COLD FOLLOW-UP DUE, one REST tally line.
    Serializes view['digest'] verbatim — never re-derives. Bullets are
    WRAP-wrapped (the 64-col any-width rule applies again now that tables are
    gone); a NOT-CERTIFIED board prints the full cert failure lines, never a
    digest of them."""
    d = view.get("digest") or {}
    ty_iso = view.get("meta", {}).get("today") or view.get("meta", {}).get("as_of") or ""
    ty = int(ty_iso[:4]) if ty_iso[:4].isdigit() else 0
    out = []
    au = view.get("audit")
    if au and not au.get("ok"):
        out.append(f"❌ AUDITOR: {au.get('summary')}")
        for a in au.get("alerts", []):
            if a.get("level") == "critical":
                out.append(f"  ❌ [{a.get('code')}] {clip(a.get('detail'), 240)}")
        for a in au.get("alerts", []):
            if a.get("level") == "warn":
                out.append(f"  ⚠️ [{a.get('code')}] {clip(a.get('detail'), 200)}")
        out.append("")
    elif au and au.get("warnings"):
        out.append(f"⚠️ AUDITOR: {au.get('summary')}")
        for a in au.get("alerts", []):
            out.append(f"  ⚠️ [{a.get('code')}] {clip(a.get('detail'), 200)}")
        out.append("")
    if view.get("certified"):
        out.append(d.get("header") or "")
    else:
        out += [seg + "  " for ln in view["cert"]["lines"] for seg in mdwrap(ln, cont="  ")]
    if view["meetings"]:
        out += ["", f"### MEETINGS ({len(view['meetings'])})"]
        out += [m["line"] for m in view["meetings"]]
    for sec in d.get("sections", []):
        if not sec.get("rows"):
            continue
        out += ["", f"### {sec['title']} ({len(sec['rows'])})", ""]
        out += [digest_line(r, ty) for r in sec["rows"]]
    # cold-DUE worklist (operator format call 2026-07-16 — it was invisible
    # behind the REST tally). Same four-field bullet as every other section;
    # the touch-ladder token ('touch N of 3' / 'final touch') rides only here.
    cold_due = d.get("cold_due") or []
    if cold_due:
        out += ["", f"### COLD FOLLOW-UP DUE ({len(cold_due)})", ""]
        out += [digest_line(r, ty) for r in cold_due]
    out += ["", "### REST", d.get("rest") or ""]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="emit the canonical view JSON (the cockpit's feed)")
    ap.add_argument("--digest", action="store_true",
                    help="compact four-field digest (lead+contact · last-message snippet "
                         "· last nudge date · no-reply count) — the /inbox-check default "
                         "since 2026-07-13, bullet one-liners since 2026-07-16; "
                         "full ledger = no flag")
    ap.add_argument("--frozen", action="store_true", help="markdown: include frozen/closed rows")
    ap.add_argument("--freeze-proposals", action="store_true",
                    help="markdown: append the cadence-exhausted cold companies as a reviewable "
                         "freeze-proposal list (audit 2026-07-08: doctrine says exhausted → "
                         "surfaced proposals, never a silent count)")
    args = ap.parse_args()
    view = build_view(json.loads(BOARD.read_text()))
    if args.json:
        print(json.dumps(view, ensure_ascii=False))
    elif args.digest:
        print(render_digest(view))
    else:
        print(render_markdown(view, show_frozen=args.frozen))
        if args.freeze_proposals:
            ex = view.get("cold_rows", {}).get("exhausted", [])
            print()
            print("\n".join(sec_header(
                f"🧊 FREEZE PROPOSALS — {len(ex)} cadence-exhausted "
                "(operator-gated; nothing auto-freezes)")))
            for r in sorted(ex, key=lambda x: (x.get("last_out_date") or "")):
                line = (f"- **{r['key']}** · {r.get('contact') or '—'} · touches {r.get('touches')} · "
                        f"last out {(r.get('last_out_date') or '—')[:10]} · "
                        f"quiet {r.get('bizdays_since_out')}bd")
                print("\n".join(mdwrap(line, cont="  ")))


if __name__ == "__main__":
    main()
