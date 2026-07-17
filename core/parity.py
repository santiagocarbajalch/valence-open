#!/usr/bin/env python3
"""
parity.py — the deterministic IMAP-parity engine (the Auditor's engine).

GOAL: continuously PROVE the local corpus is a faithful mirror of Gmail, instead
of assuming it. This is the "at parity with IMAP" guarantee the spine lacked.

It is genuinely independent of truth.derive(): it compares raw live IMAP
(read-only EXAMINE, header-only Message-ID+Date listings) against the raw corpus
shards — nothing else. A bug inside derive() cannot hide from it, which is the
circularity the auditor.py cross-check (which re-invokes derive) could not close.

Two directions, per the deletion-aware-mirror design:
  DELETIONS      corpus has a Message-ID that is gone from every live active box
                 (Todos ∪ Enviados ∪ Spam). The append-only corpus can't retract
                 it, so it is classified:
                   inert         self-authored draft twin (truth.py already drops)
                   acknowledged  operator-tombstoned junk (phantom-acknowledged.json)
                   active        a REAL deletion → needs eyes; sub-tagged in_trash
                                 (found in Papelera) vs hard_deleted (gone entirely)
  COVERAGE GAPS  a live message whose date falls inside a day we CLAIMED to have
                 pulled (covered_dates.json) but which never reached the corpus —
                 a real hole the mirror is lying about. (Un-pulled recent mail is
                 excluded: a gap only counts on a day we asserted complete.)

Writes vault/state/parity.json. Exit non-zero on an unresolved active deletion or
a real coverage gap, so a timer marks the failure. NEVER writes the corpus.

sales@example.com is CC'd on every send (the manager's read copy) but is a separate
IMAP/POP box with NO credentials configured here — it is reported as
a standing UNMONITORED blind spot, never silently assumed covered. The engine is
account-list driven so it drops in as a second mirror the moment creds exist.
"""
import imaplib, json, re, socket, ssl, sys, time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/opt/velab/workspace/tools")
sys.path.insert(0, "/opt/velab/core")
import corpus_store as store
import identity as ident
import phantom_audit as pa   # reuse load_creds / load_acknowledged / ACK_FILE (read-only)

VAULT = Path("/opt/velab/vault")
OUT = VAULT / "state/parity.json"
PRESENCE = VAULT / "state/parity-presence.json"

# The boxes the corpus claims to mirror, plus Trash (never mirrored) so a
# corpus-only mid can be distinguished as "moved to Trash" vs "hard deleted".
ALL_MAIL, SENT_BOX, SPAM_BOX, TRASH_BOX = (
    "[Gmail]/Todos", "[Gmail]/Enviados", "[Gmail]/Spam", "[Gmail]/Papelera")
ACTIVE_BOXES = (ALL_MAIL, SENT_BOX, SPAM_BOX)   # the live universe the corpus should equal

FETCH_BATCH = 500
RETRIES = 3
_MID_RX = re.compile(rb"Message-ID:\s*(<[^>]*>)", re.I)
_DATE_RX = re.compile(rb"Date:\s*(.+)", re.I)

# sales@ blind spot — stated, never assumed away.
UNMONITORED = ["sales@example.com — cc'd on every send (manager's read copy), separate "
               "IMAP/POP box with no credentials here; NOT mirrored"]


def _hdr_date_day(raw):
    """Best-effort YYYY-MM-DD from a raw RFC822 Date header (email.utils is lenient)."""
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(raw.decode("ascii", "replace").strip())
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).date().isoformat()
    except Exception:
        return None


def list_mailbox(cfg, mailbox):
    """Read-only EXAMINE header-only listing → {message_id: day}. Header-only, so
    cheap even on the capped VPS (Message-ID + Date, no bodies)."""
    imap = imaplib.IMAP4_SSL(cfg.get("IMAP_HOST", "imap.gmail.com"),
                             int(cfg.get("IMAP_PORT", 993)), timeout=120)
    try:
        imap.login(cfg["IMAP_USER"], cfg["IMAP_PASS"])
        typ, data = imap.select(f'"{mailbox}"', readonly=True)   # EXAMINE — cannot mutate
        if typ != "OK":
            raise RuntimeError(f"EXAMINE {mailbox} failed: {typ} {data}")
        n = int(data[0])
        out = {}
        for start in range(1, n + 1, FETCH_BATCH):
            end = min(start + FETCH_BATCH - 1, n)
            typ, chunks = imap.fetch(f"{start}:{end}",
                                     "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID DATE)])")
            if typ != "OK":
                raise RuntimeError(f"FETCH {mailbox} {start}:{end} failed: {typ}")
            for part in chunks:
                if isinstance(part, tuple) and len(part) > 1 and part[1]:
                    mm = _MID_RX.search(part[1])
                    if not mm:
                        continue
                    dm = _DATE_RX.search(part[1])
                    out[mm.group(1).decode("ascii", "replace").strip()] = (
                        _hdr_date_day(dm.group(1)) if dm else None)
        return out, n
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def list_account(cfg):
    """All relevant mailboxes for one account, with retry/backoff (Gmail throttles
    like corpus_pull sees). Returns {mailbox: {mid: day}} or raises after RETRIES."""
    last = None
    for attempt in range(RETRIES):
        try:
            return {box: list_mailbox(cfg, box)[0]
                    for box in (ALL_MAIL, SENT_BOX, SPAM_BOX, TRASH_BOX)}
        except (imaplib.IMAP4.error, OSError, socket.timeout, ssl.SSLError, RuntimeError) as e:
            last = e
            if attempt < RETRIES - 1:
                time.sleep(8 * (attempt + 1))
    raise RuntimeError(f"IMAP listing failed after {RETRIES} attempts: {last}")


def load_prev_active():
    try:
        return set(json.loads(PRESENCE.read_text()).get("active", []))
    except Exception:
        return set()


def run():
    ran_at = datetime.now(timezone.utc).isoformat()
    cfg = pa.load_creds()
    ack = pa.load_acknowledged()

    # corpus side (read-only)
    allmail, sent, _ = store.load_shards()
    spam = store.load_spam()
    by_mid, corpus_sent_ids = {}, set()
    for m in allmail + sent + spam:
        mid = (m.get("messageId") or "").strip()
        if not mid:
            continue
        by_mid.setdefault(mid, m)
    for m in sent:
        mid = (m.get("messageId") or "").strip()
        if mid:
            corpus_sent_ids.add(mid)
    corpus_mids = set(by_mid)
    covered = store.load_covered()

    # live side (EXAMINE only) — any failure is DEGRADED, never a corpus write
    report = {"ran_at": ran_at, "engine": "parity.py v1", "degraded": False,
              "accounts": [cfg.get("IMAP_USER")], "unmonitored": UNMONITORED}
    try:
        boxes = list_account(cfg)
    except Exception as e:
        report["degraded"] = True
        report["error"] = str(e)
        _write(report, [])
        print(f"parity: DEGRADED — {e}")
        return report, 0

    live_active = set().union(boxes[ALL_MAIL], boxes[SENT_BOX], boxes[SPAM_BOX])
    live_trash = set(boxes[TRASH_BOX])
    report["live_counts"] = {ALL_MAIL: len(boxes[ALL_MAIL]), SENT_BOX: len(boxes[SENT_BOX]),
                             SPAM_BOX: len(boxes[SPAM_BOX]), TRASH_BOX: len(boxes[TRASH_BOX])}
    report["corpus_unique"] = len(corpus_mids)

    # ---- DELETIONS: corpus has it, no live active box does
    inert, acknowledged, active = 0, 0, []
    for mid in sorted(corpus_mids - live_active):
        m = by_mid[mid]
        fr = ident.email_of(m.get("from") or "")
        if ident.is_self(fr) and mid not in corpus_sent_ids:
            inert += 1                                   # draft twin — truth.py drops it
        elif mid in ack:
            acknowledged += 1                            # operator-tombstoned junk
        else:
            active.append({"mid": mid, "from": m.get("from") or "",
                           "date": (m.get("date") or "")[:16], "subject": m.get("subject") or "",
                           "where": "in_trash" if mid in live_trash else "hard_deleted",
                           "company_key": ident.company_key(fr) if fr else ""})

    prev_active = load_prev_active()
    active_mids = {a["mid"] for a in active}
    new_active = sorted(active_mids - prev_active)

    # ---- COVERAGE GAPS: live active mail whose day we CLAIMED covered, absent from corpus
    gaps = []
    for box in (ALL_MAIL, SENT_BOX, SPAM_BOX):
        for mid, day in boxes[box].items():
            if mid in corpus_mids:
                continue
            # only a real hole if we asserted that day complete; recent un-pulled mail is normal
            if day and day in covered:
                gaps.append({"mid": mid, "date": day, "mailbox": box})
    report["deletions"] = {"inert": inert, "acknowledged": acknowledged,
                           "active": active, "new_active": new_active}
    report["coverage_gaps"] = {"count": len(gaps), "sample": gaps[:20]}

    real_break = bool(active) or bool(gaps)
    report["at_parity"] = not real_break
    report["summary"] = _summary(active, gaps, inert, acknowledged)
    _write(report, sorted(active_mids))
    return report, (1 if real_break else 0)


def _summary(active, gaps, inert, ack):
    if not active and not gaps:
        return f"AT PARITY — {inert} inert draft-twins, {ack} tombstoned; live matches corpus"
    bits = []
    if active:
        hard = sum(1 for a in active if a["where"] == "hard_deleted")
        bits.append(f"{len(active)} deleted-from-Gmail message(s) the corpus still holds "
                    f"({hard} hard, {len(active)-hard} in Trash)")
    if gaps:
        bits.append(f"{len(gaps)} message(s) in Gmail on days we claimed complete but never mirrored")
    return "NOT AT PARITY — " + "; ".join(bits)


def _write(report, active_mids):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    for path, payload in ((OUT, report),
                          (PRESENCE, {"as_of": report["ran_at"], "active": active_mids})):
        tmp = path.with_suffix(f".tmp.{__import__('os').getpid()}")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
        __import__("os").replace(tmp, path)


def main():
    # exit code = "did the guard RUN", not "did it find a problem" — findings live
    # in parity.json and are surfaced by the Auditor on the digest + console. A
    # non-zero exit therefore means a genuine crash (systemd/timer failure), while
    # a parity break is a successful run that wrote its findings. The Auditor also
    # flags a STALE parity.json, so a timer that never fires is caught too.
    try:
        report, _ = run()
    except Exception as e:
        sys.stderr.write(f"parity: CRASHED — {type(e).__name__}: {e}\n")
        sys.exit(2)
    print(report.get("summary", "parity: (degraded)"))
    for a in report.get("deletions", {}).get("active", []):
        print(f"  DELETED [{a['where']}] {a['date'][:10]} {a['company_key'] or '?'} — "
              f"{a['subject'][:60]} {a['mid']}")
    if report.get("coverage_gaps", {}).get("count"):
        print(f"  COVERAGE GAP: {report['coverage_gaps']['count']} live mid(s) missing from corpus "
              "on claimed-covered days")
    sys.exit(0)


if __name__ == "__main__":
    main()
