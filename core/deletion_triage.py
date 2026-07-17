#!/usr/bin/env python3
"""
deletion_triage.py — the LLM triage layer bolted to the parity engine's exceptions.

This is the sanctioned shape of "LLM in a cron job" under the no-LLM-in-the-spine
rule: the DETERMINISTIC layer (parity.py) decides WHAT is a real deletion; this
job only adds human-legible JUDGMENT to those few exceptions and PROPOSES an
action. It never computes parity, never gates a send, and — critically — never
acknowledges a deletion itself. A real lead's reply that was deleted must reach
the operator, so auto-acking is exactly the failure this must not commit.

Trigger: parity.json's `new_active` (deletions not seen on the previous run) —
event-driven, bounded to the handful of new exceptions, never a mailbox sweep.
Mirrors the Archivist idiom: headless `llm -p` (zero tools, prompt on stdin,
JSON parsed from output), single-flight flock, a poison-pill circuit breaker.

Writes vault/state/deletion-triage.json (proposals, status=pending). The Auditor
surfaces the pending count on the digest + console; the operator confirms with
`phantom_audit.py --ack <mid>` (junk) or rescues a real one. Read-only otherwise.
"""
import fcntl, json, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/opt/velab/workspace/tools")
sys.path.insert(0, "/opt/velab/core")
import corpus_store as store
import identity as ident

VAULT = Path("/opt/velab/vault")
PARITY = VAULT / "state/parity.json"
OUT = VAULT / "state/deletion-triage.json"
LOCK = "/tmp/velab-deletion-triage.lock"
LLM = "/usr/local/bin/llm"
TIMEOUT = 180
POISON_MAX = 2   # after N bad LLM outputs for one mid, stop retrying it

CLASSES = {"junk", "real_lead", "test", "uncertain"}

PROMPT = """You are triaging a message that was DELETED from a Velab sales Gmail account but still sits in our local mirror. Velab sells lab equipment via cold outbound; there is a single operator. Deciding wrong is costly in ONE direction only: calling a real lead's reply "junk" could bury a live deal, so when unsure, say "uncertain", never "junk".

Classify this deleted message and propose what the operator should do. Reply with ONE json object, no prose:
{"classification": "junk|real_lead|test|uncertain",
 "reason": "one plain sentence a stranger understands, no jargon",
 "proposed_action": "acknowledge as junk|rescue and reply|ignore|operator review",
 "confidence": "high|medium|low"}

junk = spam, a troll, a marketing blast, a bounce notice, or our own boilerplate. test = an internal/operator test thread. real_lead = a genuine prospect or customer message. uncertain = anything you cannot place confidently.

DELETED MESSAGE + surrounding thread context:
"""


def load_prev():
    try:
        reg = json.loads(OUT.read_text())
        return {p["mid"]: p for p in reg.get("proposals", [])}
    except Exception:
        return {}


def context_for(mid, by_company):
    """The deleted message plus up to 6 sibling messages from the same company,
    oldest→newest, so the LLM sees the thread, not one orphan line."""
    dm = None
    for msgs in by_company.values():
        for m in msgs:
            if (m.get("messageId") or "").strip() == mid:
                dm = m
                break
        if dm:
            key = ident.company_key(ident.email_of(dm.get("from") or ""))
            sib = sorted(by_company.get(key, []), key=lambda x: x.get("date") or "")[-6:]
            return dm, sib
    return None, []


def render(dm, sib):
    lines = [f"deleted: from={dm.get('from')} date={dm.get('date')} subject={dm.get('subject')}",
             f"deleted body: {(dm.get('text') or '')[:1200]}", "", "thread:"]
    for m in sib:
        who = "us" if ident.is_self(ident.email_of(m.get("from") or "")) else m.get("from")
        lines.append(f"- {m.get('date','')[:16]} {who}: {(m.get('subject') or '')[:80]} :: "
                     f"{(m.get('text') or '')[:300]}")
    return "\n".join(lines)


def classify(prompt_body):
    """Headless llm -p, zero tools, prompt on stdin — the Archivist idiom exactly."""
    try:
        r = subprocess.run([LLM, "-p", "--allowedTools", "", "--output-format", "text"],
                           input=PROMPT + prompt_body, capture_output=True, text=True, timeout=TIMEOUT)
    except Exception as e:
        return None, f"llm invocation failed: {e}"
    if r.returncode != 0:
        return None, f"llm exit {r.returncode}: {(r.stderr or '')[:160]}"
    m = re.search(r"\{.*\}", r.stdout or "", re.S)
    if not m:
        return None, "no json in llm output"
    try:
        obj = json.loads(m.group(0))
    except Exception as e:
        return None, f"bad json: {e}"
    if obj.get("classification") not in CLASSES:
        return None, f"invalid classification: {obj.get('classification')}"
    return obj, None


def run(force_mids=None):
    try:
        pj = json.loads(PARITY.read_text())
    except Exception as e:
        print(f"deletion_triage: no parity.json ({e}) — run parity.py first")
        return 0
    if pj.get("degraded"):
        print("deletion_triage: parity degraded — nothing to triage")
        return 0

    active = {a["mid"]: a for a in pj.get("deletions", {}).get("active", [])}
    targets = force_mids or pj.get("deletions", {}).get("new_active", [])
    targets = [t for t in targets if t in active]

    prev = load_prev()
    # carry forward still-relevant proposals; drop ones whose deletion resolved
    proposals = [p for p in prev.values() if p["mid"] in active]
    by_prev = {p["mid"]: p for p in proposals}

    allmail, sent, _ = store.load_shards()
    spam = store.load_spam()
    by_company = {}
    for m in allmail + sent + spam:
        fr = ident.email_of(m.get("from") or "")
        by_company.setdefault(ident.company_key(fr) if fr else "?", []).append(m)

    done = 0
    for mid in targets:
        prior = by_prev.get(mid)
        if prior and prior.get("status") == "pending" and not force_mids:
            continue  # already triaged, awaiting operator
        if prior and prior.get("poison", 0) >= POISON_MAX:
            continue
        dm, sib = context_for(mid, by_company)
        if not dm:
            continue
        obj, err = classify(render(dm, sib))
        a = active[mid]
        if err:
            rec = prior or {"mid": mid}
            rec.update({"status": "error", "poison": (prior or {}).get("poison", 0) + 1,
                        "error": err, "where": a.get("where"),
                        "company_key": a.get("company_key"), "subject": a.get("subject"),
                        "ts": datetime.now(timezone.utc).isoformat()})
            by_prev[mid] = rec
            continue
        by_prev[mid] = {"mid": mid, "status": "pending",
                        "where": a.get("where"), "date": a.get("date"),
                        "company_key": a.get("company_key"), "subject": a.get("subject"),
                        "classification": obj["classification"], "reason": obj.get("reason"),
                        "proposed_action": obj.get("proposed_action"),
                        "confidence": obj.get("confidence"),
                        "ts": datetime.now(timezone.utc).isoformat()}
        done += 1

    out = {"ran_at": datetime.now(timezone.utc).isoformat(), "engine": "deletion_triage.py v1",
           "proposals": sorted(by_prev.values(), key=lambda p: p.get("ts") or "", reverse=True)}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    tmp.replace(OUT)
    print(f"deletion_triage: {done} newly triaged, {len(out['proposals'])} pending/total")
    return 0


def main():
    import argparse
    ap = argparse.ArgumentParser(description="LLM triage of parity-detected deletions (advisory only)")
    ap.add_argument("--mid", action="append", help="force-triage a specific mid (testing)")
    args = ap.parse_args()
    lf = open(LOCK, "w")
    try:
        fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except Exception:
        print("deletion_triage: another run holds the lock — exiting")
        return 0
    return run(force_mids=args.mid)


if __name__ == "__main__":
    sys.exit(main())
