#!/usr/bin/env python3
"""certify.py — adversarial certifier v2 (blueprint §2).

Certifies the RENDERED board (vault/state/board.json) — what the operator actually sees —
against an INDEPENDENT read of the mailbox. Shares ONLY identity.py (the key contract);
zero derivation code from truth.py, so an engine bug cannot certify itself (the audited
failure of certifier v1: same cache, shared filters, flag-level parity).

Modes:
  --quick   derive independently from the corpus SHARDS (fast, catches DERIVATION bugs
            only). Default; runs on every /inbox-check. CIRCULAR vs the pull layer:
            quick reads the same shards truth.py read, so a message the warmer never
            captured is invisible here — a pull gap can NOT fail quick mode.
  --full    fresh windowed IMAP pull first (~2-4 min): Enviados + Todos (primary) and
            [Gmail]/Spam (secondary — a failed spam pull degrades to [] and never sinks
            the cert by itself). Runs the same board checks PLUS the pull-layer checks
            below. Run by the integrity timer and before any cutover.

Spam coverage (2026-07-09 overlay, mirrors truth.py's conservative fold INDEPENDENTLY):
  the corpus now captures [Gmail]/Spam into shard["spam"]. In both modes the certifier
  folds non-DSN spam whose From maps to a company the PRIMARY boxes already know as a
  normal inbound (same auto-reply/calendar gates), so a spam-folded reply that moves a
  company's last-in/whose-turn certifies instead of false-failing. DSN machine mail
  (mailer-daemon/postmaster From, or delivery-status subjects) NEVER counts as inbound
  anywhere here — truth.py only turns those into bounce annotations. Junk from unknown
  senders can never mint a company. Quick mode reads shard spam; full mode pulls Spam
  live and additionally runs the SPAM-FOLD gap check below.

Checks in BOTH modes (against board.json, per company):
  MEMBERSHIP  every independent thread with BOTH an inbound and an outbound appears on
              the board OR is explained by a gated registry (frozen/closed/dnc) or an
              identity/content class (probe/test/spam-batch). Inbound-only and cold
              (never-replied) companies are NOT row-checked here — in full mode they
              are covered by COUNTS below; in quick mode they are NOT covered at all.
  WHOSE-TURN  independent them-last vs the board bucket FAMILY (owe*/awaiting) — bucket-level,
              not flag-level: a them-last company rendered passive is a FAIL
  DATES       last_in/last_out agree to the day
  FRESH       corpus age; board as_of age
  LEDGER      cadence-ledger replied companies still on the cold ladder (warn only)

Checks in --full mode ONLY (live pull vs corpus shards — the pull layer):
  PRESENCE    every PRIMARY-box (Enviados/Todos) messageId in the fresh pull exists in
              the corpus shards; a live mid the corpus lacks = FAIL (listed with
              from/date/subject)
  SENT-SET    every live Enviados mid exists in the corpus SENT box specifically
              (a sent message captured only as an All-Mail copy = phantom-send class = FAIL)
  COUNTS      per-company in/out message counts over the PRIMARY boxes (live vs corpus,
              same attribution + noise filters, in-window, mid-deduped) for the classes
              MEMBERSHIP skips: board-cold and inbound-only companies. live > corpus =
              FAIL naming the company. corpus > live is the phantom class (below), never a FAIL.
  SPAM-FOLD   every live spam message that WOULD fold as genuine inbound (non-DSN, known
              company, passes the auto-reply/calendar gates) must already be captured in
              the corpus (spam or allmail) = else FAIL: the board derived blind to a real
              reply. Machine spam (DSN/autoreply/unknown sender) is junk the corpus owes
              nothing to — never checked, never failed.
  PHANTOM     report-only: count of in-window PRIMARY corpus mids absent from the live
              pull. Expected from the append-only corpus design (baseline ~101 inert
              draft twins); the nightly reconciler owns the deep analysis — never a FAIL.

Writes the cert block into board.json (displayed by every surface). Exit 0 = certified.
"""
import argparse, json, os, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import identity as ident

VAULT = Path("/opt/velab/vault")
BOARD = VAULT / "state/board.json"
CORPUS_DIR = VAULT / "inbox/intel/corpus"
IMAP_SKILL = "/opt/velab/workspace/skills/imap-smtp-email"
SINCE = "2026-05-01"

FRESH_BOARD_MAX_MIN = 20
FRESH_CORPUS_MAX_MIN = 20

# ------------------------------------------------------------ independent corpus reads
def load_shard_msgs():
    msgs = []
    for p in sorted(CORPUS_DIR.glob("2026-*.json")):
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        for box in ("allmail", "sent"):
            for m in d.get(box) or []:
                m["_box"] = box
                msgs.append(m)
    return msgs

def load_shard_spam():
    """Own read of shard["spam"] (2026-07-09 overlay) — deliberately NOT corpus_store.load_spam():
    the certifier keeps its own loader so a shared-loader bug cannot certify itself."""
    spam = []
    for p in sorted(CORPUS_DIR.glob("2026-*.json")):
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        for m in d.get("spam") or []:
            m["_box"] = "spam"
            spam.append(m)
    return spam

def fresh_pull():
    """Date-windowed live pull (the Phase-0 audit method).
    Returns (primary_msgs, spam_msgs) or None if a PRIMARY box fails; a failed
    [Gmail]/Spam window degrades to nothing pulled (secondary — mirrors corpus_pull)."""
    from datetime import date, timedelta
    windows, cur = [], date.fromisoformat(SINCE)
    today = datetime.now(timezone.utc).date()
    while cur <= today:
        nxt = cur + timedelta(days=15)
        windows.append((cur.isoformat(), nxt.isoformat() if nxt <= today else None))
        cur = nxt
    out, seen = [], set()
    # Enviados FIRST: the cross-mailbox mid-dedup must keep the sent-box copy so
    # real sends carry _box="sent"; Todos-only self-authored = drafts (Borradores).
    for mailbox in ("[Gmail]/Enviados", "[Gmail]/Todos"):
        for since, before in windows:
            cmd = ["node", "scripts/imap.js", "search", "--mailbox", mailbox,
                   "--limit", "8000", "--since", since] + (["--before", before] if before else [])
            r = None
            for attempt in range(5):   # Gmail login-rate throttle shows as rc0/empty stdout;
                r = subprocess.run(cmd, cwd=IMAP_SKILL, capture_output=True, text=True, timeout=540)
                if r.returncode == 0 and (r.stdout or "").strip():
                    break
                import time                     # a partial pull never certifies, so wait it out
                time.sleep(20 * (attempt + 1))  # 20/40/60/80s — outlasts the throttle window
            if r.returncode != 0 or not (r.stdout or "").strip():
                return None
            for m in json.loads(r.stdout):
                mid = m.get("messageId")
                if mid and mid in seen:
                    continue
                if mid:
                    seen.add(mid)
                m["_box"] = "sent" if mailbox == "[Gmail]/Enviados" else "allmail"
                out.append(m)
    # [Gmail]/Spam is SECONDARY (2026-07-09 overlay): needed for spam-fold parity and
    # the SPAM-FOLD gap check, but a failed window is skipped — spam alone never sinks
    # the certification (the corpus warmer takes the same stance).
    spam = []
    for since, before in windows:
        cmd = ["node", "scripts/imap.js", "search", "--mailbox", "[Gmail]/Spam",
               "--limit", "8000", "--since", since] + (["--before", before] if before else [])
        r = None
        for attempt in range(3):
            try:
                r = subprocess.run(cmd, cwd=IMAP_SKILL, capture_output=True, text=True, timeout=540)
            except Exception:
                r = None
                break
            if r.returncode == 0 and (r.stdout or "").strip():
                break
            import time
            time.sleep(20 * (attempt + 1))
        if r is None or r.returncode != 0 or not (r.stdout or "").strip():
            continue
        try:
            rows = json.loads(r.stdout)
        except Exception:
            continue
        for m in rows:
            mid = m.get("messageId")
            if mid and mid in seen:
                continue
            if mid:
                seen.add(mid)
            m["_box"] = "spam"
            spam.append(m)
    return out, spam

# ------------------------------------------------------------ independent derivation
_NOISE = re.compile(r"mailer-daemon|postmaster|no-?reply|noreply|daemon@|dmarc|calendar-notification|"
                    r"drive-shares|google\.com|notifications?@|bounces?@|tldv\.io|calendly|slack|atlassian", re.I)
_AUTO = re.compile(r"automatic reply|out of office|respuesta autom|fuera de (la )?oficina|autoreply", re.I)
# calendar notices carry the LEAD's From address but are machine mail — same rule as
# truth.CAL_NOTICE_SUBJ (they never count as "they wrote last"; 2026-07-07 fix)
_CAL_SUBJ = re.compile(r"^\s*(aceptada?|accepted|rechazada?|declined|invitaci[oó]n( actualizada)?|"
                       r"(updated )?invitation)[:\s]", re.I)
# DSN machine mail (same shapes truth.py annotates as bounces — duplicated on purpose,
# the certifier never imports derivation code): NEVER counts as inbound anywhere here.
_DSN_FROM = re.compile(r"mailer-daemon|postmaster", re.I)
_DSN_SUBJ = re.compile(r"delivery status|undeliver|no se pudo entregar|devuelto", re.I)

def _spam_foldable(m, known_keys):
    """True iff a spam-box message would fold as GENUINE inbound under the conservative
    2026-07-09 overlay: non-DSN, sender maps to a company the primary boxes already know
    (junk can never mint a company), and passes the auto-reply/calendar gates."""
    fr = ident.email_of(m.get("from", ""))
    subj = m.get("subject") or ""
    if _DSN_FROM.search(m.get("from") or "") or _DSN_SUBJ.search(subj):
        return False
    if not fr or ident.is_self(fr) or _NOISE.search(m.get("from") or ""):
        return False
    k = ident.company_key(fr)
    if not k or k not in known_keys:
        return False
    return not _AUTO.search(subj) and not _CAL_SUBJ.search(subj)

def independent_state(msgs, spam_msgs=()):
    """Own aggregation: per company key -> last genuine inbound / last outbound. No truth.py code.
    Spam fold: non-DSN spam from an already-known company counts as inbound (a misrouted
    real reply must move whose-turn, matching truth.py's fold); DSNs/junk never do.
    Cross-TLD fold (rule parity 2026-07-10, independent implementation): a message —
    ours or theirs — whose References chain points into a sibling-brand conversation
    (same brand label, different TLD) belongs to that conversation's key. Walked
    chronologically so the mapping is transitive across truncated chains."""
    agg = {}
    mid2key = {}
    for m in sorted(msgs, key=lambda x: x.get("date") or ""):
        fr, to = ident.email_of(m.get("from", "")), ident.email_of(m.get("to", ""))
        inbound = not ident.is_self(fr)
        cp = fr if inbound else to
        if not cp or ident.is_self(cp) or _NOISE.search(m.get("from") or "" if inbound else cp):
            continue
        k = ident.company_key(cp)
        if not k:
            continue
        refs = m.get("references") or []
        if isinstance(refs, str):
            refs = refs.split()
        for r in [m.get("inReplyTo")] + list(refs):
            ak = mid2key.get(r)
            if ak and ak != k and ak.split(".")[0] == k.split(".")[0]:
                k = ak
                break
        if m.get("messageId"):
            mid2key[m["messageId"]] = k
        d = (m.get("date") or "")[:16]
        a = agg.setdefault(k, {"in": "", "out": ""})
        if inbound:
            subj = m.get("subject") or ""
            if not _AUTO.search(subj) and not _CAL_SUBJ.search(subj):
                a["in"] = max(a["in"], d)
        elif m.get("_box") == "sent":
            # SEND-BOX TRUTH: self-authored counts as outbound only from Enviados —
            # All Mail carries Borradores drafts (the 2026-07-07 phantom-send audit)
            a["out"] = max(a["out"], d)
    for m in spam_msgs:
        if _spam_foldable(m, agg):
            k = ident.company_key(ident.email_of(m.get("from", "")))
            agg[k]["in"] = max(agg[k]["in"], (m.get("date") or "")[:16])
    return agg

# ------------------------------------------------------------ pull-layer checks (--full only)
def _dedup_prefer_sent(msgs):
    """Mid-dedup keeping the sent-box copy (same rule as fresh_pull's cross-mailbox dedup),
    so a real send never degrades to its All-Mail twin on either side of a comparison."""
    by = {}
    for m in msgs:
        mid = m.get("messageId")
        if not mid:
            continue
        cur = by.get(mid)
        if cur is None or (m.get("_box") == "sent" and cur.get("_box") != "sent"):
            by[mid] = m
    return list(by.values())

def _company_counts(msgs):
    """Per-company in/out message counts, in-window (>= SINCE), sent-box-only outbound.
    SAME attribution + noise filter as independent_state, applied to BOTH sides of the
    live-vs-corpus comparison so the filters cancel out. Callers pass mid-deduped msgs."""
    counts = {}
    for m in msgs:
        d = (m.get("date") or "")[:10]
        if not d or d < SINCE:
            continue
        fr, to = ident.email_of(m.get("from", "")), ident.email_of(m.get("to", ""))
        inbound = not ident.is_self(fr)
        cp = fr if inbound else to
        if not cp or ident.is_self(cp) or _NOISE.search(m.get("from") or "" if inbound else cp):
            continue
        k = ident.company_key(cp)
        if not k:
            continue
        c = counts.setdefault(k, {"in": 0, "out": 0})
        if inbound:
            c["in"] += 1
        elif m.get("_box") == "sent":
            c["out"] += 1
    return counts

def pull_layer_checks(live, live_spam, shard_msgs, shard_spam, rows, indep):
    """--full only: fresh live pull vs the corpus shards (the pull layer). Implements
    PRESENCE / SENT-SET / COUNTS / SPAM-FOLD / PHANTOM from the module docstring.
    Returns (fails, infos, extras) — extras carry the structured detail for the cert block."""
    fails, infos, extras = [], [], {}
    live_dd = _dedup_prefer_sent(live)          # fresh_pull already dedups; idempotent
    corpus_dd = _dedup_prefer_sent(shard_msgs)  # shards repeat mids across days/boxes
    corpus_mids = {m["messageId"] for m in corpus_dd}
    corpus_sent_mids = {m["messageId"] for m in corpus_dd if m.get("_box") == "sent"}
    live_mids = {m["messageId"] for m in live_dd}

    # PRESENCE — every live mid must already be captured in the corpus (any box)
    missing = [m for m in live_dd if m["messageId"] not in corpus_mids]
    extras["pull_missing"] = [{"mid": m["messageId"], "from": m.get("from"),
                               "date": (m.get("date") or "")[:16], "subject": m.get("subject")}
                              for m in missing[:15]]
    if missing:
        fails.append(f"{len(missing)} live message(s) MISSING from corpus shards (pull-layer gap) — listed below")
    else:
        infos.append(f"pull PRESENCE: all {len(live_mids)} live mids present in corpus shards")

    # SENT-SET — a live Enviados mid the corpus holds only as an All-Mail copy is the
    # phantom-send class (2026-07-07 audit): send-box truth must hold in the corpus too
    live_sent = {m["messageId"] for m in live_dd if m.get("_box") == "sent"}
    sent_gap = sorted(live_sent - corpus_sent_mids)
    extras["sent_set_gap"] = sent_gap[:15]
    if sent_gap:
        fails.append(f"{len(sent_gap)} live Enviados mid(s) absent from the corpus sent box "
                     f"(phantom-send class): {', '.join(sent_gap[:5])}")
    else:
        infos.append(f"pull SENT-SET: all {len(live_sent)} live Enviados mids present in corpus sent box")

    # COUNTS — the classes MEMBERSHIP row-skips: board-cold + inbound-only companies.
    # live > corpus = the corpus lost/never captured their mail = FAIL naming the company.
    # corpus > live = phantom class (append-only exhaust), reported below, never a FAIL.
    live_counts = _company_counts(live_dd)
    corpus_counts = _company_counts(corpus_dd)
    cold_keys = {k for k, c in rows.items() if c.get("bucket") == "cold"}
    inbound_only = {k for k, c in live_counts.items() if c["in"] and not c["out"] and k not in rows}
    count_fails = []
    for k in sorted(cold_keys | inbound_only):
        lc = live_counts.get(k, {"in": 0, "out": 0})
        cc = corpus_counts.get(k, {"in": 0, "out": 0})
        if lc["in"] > cc["in"] or lc["out"] > cc["out"]:
            count_fails.append({"key": k, "live": lc, "corpus": cc})
    extras["count_fails"] = count_fails[:15]
    if count_fails:
        fails.append(f"{len(count_fails)} cold/inbound-only company(ies) with live counts EXCEEDING corpus: "
                     + ", ".join(c["key"] for c in count_fails[:8]))
    else:
        infos.append(f"pull COUNTS: {len(cold_keys | inbound_only)} cold/inbound-only companies "
                     f"count-checked (live vs corpus in/out) — none undercaptured")

    # SPAM-FOLD — a live spam message that WOULD fold as genuine inbound must already
    # be captured by the corpus (spam or allmail), or truth.py derived the board blind
    # to a real reply. Machine spam (DSN/autoreply/unknown sender) is junk the corpus
    # owes nothing to — neither checked nor failed.
    corpus_spam_mids = {m["messageId"] for m in shard_spam if m.get("messageId")}
    fold_gap = [{"mid": m["messageId"], "from": m.get("from"),
                 "date": (m.get("date") or "")[:16], "subject": m.get("subject")}
                for m in live_spam
                if m.get("messageId") and m["messageId"] not in corpus_spam_mids
                and m["messageId"] not in corpus_mids and _spam_foldable(m, indep)]
    extras["spam_fold_gap"] = fold_gap[:15]
    if fold_gap:
        fails.append(f"{len(fold_gap)} foldable spam message(s) — real inbound in [Gmail]/Spam — "
                     f"missing from corpus capture (board derived blind to them) — listed below")
    else:
        infos.append(f"pull SPAM-FOLD: {len(live_spam)} live spam msg(s) checked — "
                     f"no foldable inbound missing from corpus")

    # PHANTOM — report-only: in-window corpus mids the live pull no longer sees.
    # Expected from the append-only design (~101 inert draft-twin baseline); the nightly
    # reconciler owns the deep analysis. Never a FAIL here.
    phantom = sum(1 for m in corpus_dd
                  if m["messageId"] not in live_mids and (m.get("date") or "")[:10] >= SINCE)
    extras["phantom_corpus_only"] = phantom
    infos.append(f"phantom-aware: {phantom} in-window corpus mid(s) absent from the live pull "
                 f"(append-only exhaust; reconciler owns analysis)")
    return fails, infos, extras

# ------------------------------------------------------------ registry loads (independent, minimal)
def gated_keys():
    gated = {}
    try:
        f = json.load(open(VAULT / "pipeline/operator-frozen.json"))
        for e in (f.get("frozen", []) if isinstance(f, dict) else f):
            if isinstance(e, dict) and e.get("domain"):
                gated[ident.company_key(e.get("email") or e["domain"])] = "frozen"
    except Exception:
        pass
    try:
        c = json.load(open(VAULT / "pipeline/closed.json"))
        rows = c.get("closed", c) if isinstance(c, dict) else c
        it = rows.items() if isinstance(rows, dict) else [(e.get("domain"), e) for e in rows if isinstance(e, dict)]
        for k, _ in it:
            if k:
                gated[ident.company_key(k)] = "closed"
    except Exception:
        pass
    dnc_emails = set()
    try:
        for line in open(VAULT / "suppression/dnc.jsonl"):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("email"):
                dnc_emails.add(r["email"].lower())
            elif r.get("domain"):
                gated[ident.company_key(r["domain"])] = "dnc"
    except Exception:
        pass
    try:
        active = False
        for line in open(VAULT / "reference/dnc-domains.md"):
            s = line.strip()
            if s.startswith("## Active DNC"):
                active = True; continue
            if s.startswith("## ") and "Active DNC" not in s:
                active = False
            if active:
                for d in re.findall(r"`([\w.-]+\.\w+)`", s):
                    gated[ident.company_key(d)] = "dnc"
    except Exception:
        pass
    return gated, dnc_emails

# ------------------------------------------------------------ the certification
OWE_FAMILY = {"owe", "owe-review", "institutional"}   # institutional = its own VISIBLE lane (Licitador)
EXPLAINED = {"spam", "probe", "test", "frozen", "closed", "dnc"}

def run(mode):
    fails, warns = [], []
    try:
        board = json.loads(BOARD.read_text())
    except Exception as e:
        return {"certified": False, "fails": [f"board.json unreadable: {e}"]}, None

    meta = board.get("meta", {})
    now = datetime.now(timezone.utc)

    # FRESH
    try:
        as_of = datetime.fromisoformat(meta["as_of"])
        board_age = (now - as_of).total_seconds() / 60
    except Exception:
        board_age = 9e9
    if board_age > FRESH_BOARD_MAX_MIN:
        fails.append(f"board is {int(board_age)}m old (> {FRESH_BOARD_MAX_MIN}m) — re-derive before trusting it")
    age = meta.get("corpus_age_min")
    if age is None or age > FRESH_CORPUS_MAX_MIN:
        warns.append(f"corpus was {age}m old at derive time (warmer degraded?)")
    if meta.get("degraded"):
        fails.append("board derived from an EMPTY corpus — never trust it")

    # independent read
    live = live_spam = None
    if mode == "full":
        pulled = fresh_pull()
        if pulled is None:
            fails.append("fresh IMAP pull failed — cannot adversarially certify (quick-mode shards only)")
            msgs, spam_msgs = load_shard_msgs(), load_shard_spam()
            mode = "quick(fallback)"
        else:
            live, live_spam = pulled
            msgs, spam_msgs = live, live_spam
    else:
        msgs, spam_msgs = load_shard_msgs(), load_shard_spam()
    indep = independent_state(msgs, spam_msgs)
    gated, dnc_emails = gated_keys()

    rows = {c["key"]: c for c in board.get("companies", [])}

    # PULL-LAYER (--full only): the live pull vs the corpus shards themselves —
    # PRESENCE / SENT-SET / COUNTS / SPAM-FOLD / PHANTOM (module docstring).
    infos, pull_extras = [], {}
    if live is not None:
        p_fails, infos, pull_extras = pull_layer_checks(
            live, live_spam, load_shard_msgs(), load_shard_spam(), rows, indep)
        fails += p_fails

    # WHOSE-TURN + DATES (bucket-level — the v1 blind spot)
    turn_fails, date_fails = [], []
    for k, c in rows.items():
        a = indep.get(k)
        if not a:
            continue
        indep_them_last = bool(a["in"] and a["in"] > a["out"])
        rendered_active = c["bucket"] in OWE_FAMILY or c.get("state") in (
            "declined", "routed-internally", "promised-revert", "awaiting-them")
        # inbound_only (first-contact senders, on the board since 2026-07-11) is
        # its own VISIBLE review lane — them-last is its defining condition, not
        # a whose-turn breach.
        if indep_them_last and c["bucket"] not in OWE_FAMILY and c["bucket"] != "inbound_only":
            # them-last rendered passive: legitimate ONLY for explicit parked states
            if c.get("state") not in ("declined", "routed-internally", "promised-revert"):
                turn_fails.append({"key": k, "bucket": c["bucket"], "state": c.get("state"),
                                   "raw_in": a["in"], "raw_out": a["out"]})
        for fld, mine in (("last_in_date", a["in"]), ("last_out_date", a["out"])):
            b = (c.get(fld) or "")[:10]
            if mine and b and mine[:10] != b:
                date_fails.append({"key": k, "field": fld, "board": b, "independent": mine[:10]})
    if turn_fails:
        fails.append(f"{len(turn_fails)} them-last company(ies) rendered passive (bucket-level whose-turn breach)")
    if date_fails:
        fails.append(f"{len(date_fails)} last-in/out date disagreement(s) vs independent read")

    # MEMBERSHIP: every live independent thread must be on the board or explained
    missing = []
    for k, a in indep.items():
        if not (a["in"] and a["out"]):
            continue  # cold or inbound-only universes are count-checked, not row-checked
        if k in rows or k in gated:
            continue
        # engine-classed suppression (spam/probe/test) won't be in rows: consult full output
        missing.append({"key": k, "in": a["in"], "out": a["out"]})
    all_classes = {c["key"]: (c.get("suppressed") or c.get("bucket")) for c in board.get("companies", [])}
    truly_missing = []
    for m in missing:
        k = m["key"]
        kls = ident.classify_identity(k)
        if kls in ("probe", "test"):
            continue
        truly_missing.append(m)
    # spam-batch companies aren't in board rows; re-check their content class from the corpus
    if truly_missing:
        spamish = set()
        blob_by_key = {}
        for msg in msgs:
            cp = ident.email_of(msg.get("from", "")) or ""
            k = ident.company_key(cp if not ident.is_self(cp) else ident.email_of(msg.get("to", "")))
            if k in {m["key"] for m in truly_missing}:
                blob_by_key.setdefault(k, []).append((msg.get("subject") or "") + " " + (msg.get("snippet") or ""))
        for k, blobs in blob_by_key.items():
            if ident.classify_identity(k, " ".join(blobs), " ".join(blobs)) == "spam-batch":
                spamish.add(k)
        truly_missing = [m for m in truly_missing if m["key"] not in spamish
                         and not any(p in dnc_emails for p in [])]  # email-DNC handled below
        # email-level DNC sole-contact erasure (audited leegov case): explained, but must be counted
        dnc_erased = []
        for m in list(truly_missing):
            k = m["key"]
            people = {ident.email_of(x.get("from", "")) for x in msgs
                      if ident.company_key(ident.email_of(x.get("from", ""))) == k and not ident.is_self(ident.email_of(x.get("from", "")))}
            if people and people <= dnc_emails:
                dnc_erased.append(k)
                truly_missing.remove(m)
        if dnc_erased:
            warns.append(f"{len(dnc_erased)} company(ies) fully erased by email-level DNC (sole contact): {', '.join(dnc_erased[:5])}")
    if truly_missing:
        fails.append(f"{len(truly_missing)} live thread(s) MISSING from board and unexplained: "
                     + ", ".join(m["key"] for m in truly_missing[:8]))

    # LEDGER ↔ BOARD reply parity (audit 2026-07-08, the Acme miss): the cadence
    # ledger is the one register that keeps `replied` monotonic across mailbox
    # deletions. A ledger-replied company still riding the cold ladder means either
    # the corpus lost the reply, the reply landed outside robert@ (sales@ cc), or
    # one system is misreading an autoreply — every case is operator-visible.
    try:
        led = json.load(open(VAULT / "pipeline/cadence/ledger.json"))
        led_replied_cold = []
        for lead in led.get("leads", []):
            if not lead.get("replied"):
                continue
            k = ident.company_key((lead.get("email") or "").lower())
            if k and rows.get(k, {}).get("bucket") == "cold":
                led_replied_cold.append(k)
        if led_replied_cold:
            warns.append(f"{len(led_replied_cold)} ledger-REPLIED company(ies) still in the cold ladder "
                         f"(lost/out-of-universe reply?): {', '.join(sorted(set(led_replied_cold))[:6])}")
    except Exception:
        pass

    cert = {
        "certified": not fails,
        "mode": mode,
        "checked_at": now.isoformat(),
        "independent_msgs": len(msgs),
        "companies_checked": len([k for k in rows if k in indep]),
        "turn_fails": turn_fails[:15],
        "date_fails": date_fails[:15],
        "missing": truly_missing[:15],
        "fails": fails,
        "warns": warns,
        "infos": infos,           # full-mode pull-layer results (informational, ✅-prefixed)
        **pull_extras,            # pull_missing / sent_set_gap / count_fails / spam_fold_gap / phantom_corpus_only
    }
    return cert, board


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="fresh IMAP pull (adversarial vs pull layer too)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    cert, board = run("full" if args.full else "quick")
    if board is not None:
        board["cert"] = cert
        tmp = BOARD.with_suffix(".tmp")
        tmp.write_text(json.dumps(board, ensure_ascii=False))
        os.replace(tmp, BOARD)
    if cert.get("mode") == "full":
        # durable stamp — quick-mode renders show the age of the last DEEP check
        # (quick cert is circular vs the shards; only --full reads Gmail live)
        BOARD.parent.joinpath("last_full_cert.json").write_text(json.dumps(
            {"at": cert["checked_at"], "certified": cert["certified"],
             "fails": cert.get("fails", [])}, ensure_ascii=False))
    if args.json:
        print(json.dumps(cert, ensure_ascii=False, indent=1))
    else:
        mark = "✅ CERTIFIED" if cert["certified"] else "❌ NOT CERTIFIED"
        print(f"{mark} — rendered board vs independent mailbox read (mode: {cert['mode']})")
        print(f"  {cert.get('independent_msgs', 0)} msgs read independently · "
              f"{cert.get('companies_checked', 0)} companies cross-checked")
        for i in cert.get("infos", []):
            print(f"  ✅ {i}")
        for w in cert.get("warns", []):
            print(f"  ⚠️  {w}")
        for f in cert.get("fails", []):
            print(f"  ❌ {f}")
        for t in cert.get("turn_fails", [])[:8]:
            print(f"     ↔ {t['key']}: they spoke last ({t['raw_in']}) but rendered {t['bucket']}/{t['state']}")
        for m in cert.get("pull_missing", [])[:8]:
            print(f"     ✉ {m['mid']} · {m.get('from')} · {m.get('date')} · {m.get('subject')}")
        for m in cert.get("spam_fold_gap", [])[:8]:
            print(f"     ✉ SPAM {m['mid']} · {m.get('from')} · {m.get('date')} · {m.get('subject')}")
        for c in cert.get("count_fails", [])[:8]:
            print(f"     Σ {c['key']}: live in/out {c['live']['in']}/{c['live']['out']} "
                  f"vs corpus {c['corpus']['in']}/{c['corpus']['out']}")
    sys.exit(0 if cert["certified"] else 1)


if __name__ == "__main__":
    main()
