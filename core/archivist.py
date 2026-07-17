#!/usr/bin/env python3
"""archivist.py — Archivist v2 (blueprint §3).

Company-level contextualization on top of the persisted truth:
  eligibility from board.json (new activity since last verdict — NEVER cadence/freeze
  status), bundles built from the corpus SHARDS (no private IMAP pulls — the 4-corpora
  problem ends), headless `claude -p` with ZERO tools (JSON on stdout; the wrapper
  validates and writes — no injection surface), content-only hashing (no TODAY),
  flock around the whole run, poison-pill after 3 bad outputs, meetings applied
  deterministically to vault/meetings/<status>/<domain>-<date>.md with aligned enums.

Run: python3 archivist.py [--dry] [--limit N] [--force <key>]
Scheduled by archivist2.timer (15 min); corpus freshness is corpus-reconcile's job.
"""
import argparse, fcntl, hashlib, json, os, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import identity as ident
import truth  # reuse: shard load + body/strip helpers (same package, not a divergent engine)

VAULT = Path("/opt/velab/vault")
BOARD = VAULT / "state/board.json"
V2DIR = VAULT / "inbox/intel/verdicts2"
MANIFEST = V2DIR / "manifest.json"
MEETINGS = VAULT / "meetings"
LOCK = Path("/tmp/velab-archivist2.lock")
PROMPT = Path(__file__).resolve().parent / "archivist_prompt.md"

MAXPAR = 1            # sequential; the queue is small once hashing is content-only
TIMEOUT = 240
POISON_MAX = 3
MEET_STATUSES = ("proposed", "scheduled", "held", "canceled")
STAGE_SIGNALS = {"cold-no-reply", "replied-interest", "info-exchange", "quote-sent",
                 "negotiation", "meeting-proposed", "meeting-scheduled", "meeting-held",
                 "customer", "dormant", "not-interested", "closed-lost"}


def load_manifest():
    try:
        return json.loads(MANIFEST.read_text())
    except Exception:
        return {}


def save_manifest(m):
    V2DIR.mkdir(parents=True, exist_ok=True)
    tmp = MANIFEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(m, ensure_ascii=False, indent=1))
    os.replace(tmp, MANIFEST)


def company_bundle(key, msgs):
    """Chronological both-direction bundle for ONE company key, from the shard corpus."""
    rows = []
    for m in msgs:
        fr, to = ident.email_of(m.get("from", "")), ident.email_of(m.get("to", ""))
        inbound = not ident.is_self(fr)
        cp = fr if inbound else to
        if not cp or ident.company_key(cp) != key:
            continue
        body = truth.body_of(m)
        rows.append(((m.get("date") or "")[:16], inbound, fr if inbound else "us->" + to,
                     m.get("subject") or "", truth.strip_quoted(body)[:2500]))
    rows.sort()
    lines = [f"COMPANY: {key}", f"MESSAGES: {len(rows)}", ""]
    for d, inbound, who, subj, body in rows:
        lines.append(f"[{d}] {'THEM' if inbound else 'US'} ({who}) | {subj}")
        lines.append(body or "(empty)")
        lines.append("---")
    return "\n".join(lines), rows


def bundle_hash(rows):
    h = hashlib.sha256()
    for d, inbound, who, subj, body in rows:
        h.update(f"{d}|{inbound}|{who}|{subj}|{body[:800]}".encode())
    return h.hexdigest()


def read_one(key, bundle):
    """Headless claude with ZERO tools; JSON on stdout only."""
    prompt = PROMPT.read_text() + "\n\n=== COMPANY BUNDLE ===\n" + bundle[:180000]
    r = subprocess.run(
        ["/usr/local/bin/llm", "-p", "--allowedTools", "", "--output-format", "text"],
        input=prompt, capture_output=True, text=True, timeout=TIMEOUT)
    out = (r.stdout or "").strip()
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        return None, f"no JSON in output ({out[:120]!r})"
    try:
        v = json.loads(m.group(0))
    except Exception as e:
        return None, f"bad JSON: {e}"
    if v.get("stage_signal") not in STAGE_SIGNALS:
        return None, f"bad stage_signal {v.get('stage_signal')!r}"
    if not v.get("summary") or not v.get("next_action"):
        return None, "missing summary/next_action"
    return v, None


def apply_meetings(key, verdict):
    """Deterministic meeting files: <domain>-<date>.md under the ONE correct status dir."""
    for mt in verdict.get("meetings") or []:
        date, status = (mt.get("date") or "")[:10], mt.get("status")
        if not date or status not in MEET_STATUSES:
            continue
        fname = f"{date}-{ident.registrable_domain(key) if '@' not in key else key.replace('@','-at-')}.md"
        body = (f"# Meeting — {verdict.get('institution') or key}\n\n"
                f"- **Date:** {date} {mt.get('time') or ''}\n"
                f"- **Status:** {status}\n"
                f"- **With:** {mt.get('with') or '—'}\n"
                f"- **Company:** [[{key}]] → vault/companies/\n"
                f"- **Notes:** {mt.get('notes') or '—'}\n\n"
                f"_Written by Archivist v2 {datetime.now(timezone.utc).isoformat()} — regenerated, do not hand-edit._\n")
        for st in MEET_STATUSES:
            p = MEETINGS / st / fname
            if st == status:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(body)
            elif p.exists():
                p.unlink()   # a meeting lives in exactly ONE status dir


def eligible(board, manifest, force=None):
    out = []
    rows = board.get("companies", []) + board.get("suppressed_engaged", [])
    for c in rows:
        key = c["key"]
        if force and key != force:
            continue
        if not c.get("last_in_date"):
            continue                       # never engaged — nothing to narrate
        if c.get("class") in ("probe", "test", "spam-batch"):
            continue
        ent = manifest.get(key) or {}
        if ent.get("poisoned"):
            continue
        if force:
            out.append(key); continue
        last_act = max(c.get("last_in_date") or "", c.get("last_out_date") or "")
        if ent.get("last_activity") == last_act and ent.get("analyzed_hash"):
            continue                       # nothing new since last read
        out.append(key)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--force", help="re-read one company key regardless of hash")
    args = ap.parse_args()

    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another archivist run holds the lock — exiting"); return 0

    board = json.loads(BOARD.read_text())
    manifest = load_manifest()
    queue = eligible(board, manifest, args.force)[: args.limit]
    print(f"eligible: {len(queue)}")
    if args.dry:
        print("\n".join(queue)); return 0

    allmail, sent, _ = truth.corpus_store.load_shards()
    seen, msgs = set(), []
    for m in list(allmail) + list(sent):
        mid = m.get("messageId")
        if mid and mid in seen:
            continue
        if mid:
            seen.add(mid)
        msgs.append(m)

    rows_by_key = {c["key"]: c for c in board.get("companies", []) + board.get("suppressed_engaged", [])}
    done = failed = skipped = 0
    for key in queue:
        bundle, rows = company_bundle(key, msgs)
        h = bundle_hash(rows)
        ent = manifest.get(key) or {}
        if ent.get("analyzed_hash") == h and not args.force:
            c = rows_by_key.get(key, {})
            ent["last_activity"] = max(c.get("last_in_date") or "", c.get("last_out_date") or "")
            manifest[key] = ent; skipped += 1
            continue
        verdict, err = None, None
        try:
            verdict, err = read_one(key, bundle)
        except subprocess.TimeoutExpired:
            err = "timeout"
        except Exception as e:
            err = str(e)
        if verdict is None:
            ent["fails"] = int(ent.get("fails") or 0) + 1
            if ent["fails"] >= POISON_MAX:
                ent["poisoned"] = True
                print(f"  ✗ {key}: {err} — POISONED after {ent['fails']} fails")
            else:
                print(f"  ✗ {key}: {err} (fail {ent['fails']}/{POISON_MAX})")
            manifest[key] = ent; failed += 1
            save_manifest(manifest)
            continue
        verdict["company"] = key
        verdict["read_at"] = datetime.now(timezone.utc).isoformat()
        V2DIR.mkdir(parents=True, exist_ok=True)
        vp = V2DIR / f"{re.sub(r'[^a-z0-9.@-]+', '-', key)}.json"
        tmp = vp.with_suffix(".tmp")
        tmp.write_text(json.dumps(verdict, ensure_ascii=False, indent=1))
        os.replace(tmp, vp)
        apply_meetings(key, verdict)
        c = rows_by_key.get(key, {})
        manifest[key] = {"analyzed_hash": h, "read_at": verdict["read_at"], "fails": 0,
                         "last_activity": max(c.get("last_in_date") or "", c.get("last_out_date") or "")}
        save_manifest(manifest)
        print(f"  ✓ {key}: {verdict['stage_signal']}")
        done += 1
    save_manifest(manifest)
    print(f"done {done} · skipped(hash) {skipped} · failed {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
