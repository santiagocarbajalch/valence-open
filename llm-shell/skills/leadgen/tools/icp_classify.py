#!/opt/scrapling-venv/bin/python3
"""icp_classify.py — the ICP-RELEVANCE GATE. Reads what a company actually DOES and
decides distributor / adjacent / off-ICP BEFORE the Reacher verify step.

Why this exists (2026-06-24 system review): nothing in the funnel ever read a site's
content to confirm it sells lab equipment. The scraper stamps every lead `icp_match: True`
unconditionally; Reacher only proves an email is *deliverable*. So law firms, logistics
brokers, EHS consultancies, hobby-electronics shops and manufacturer HQs sailed straight
to "verified" and were only caught by a manual web-classification step at the end. This
tool automates that step and puts it WHERE IT BELONGS — post-scrape, pre-verify — so:
  (a) off-ICP companies are removed before they waste a Reacher call, and
  (b) the verdict (and WHY) is recorded on every lead for the leadbook + the tunnel ledger.

It reuses qualify.profile()'s proven fetch+evidence path (one fetch per registrable
domain, cached) and scores the site text against an editable EN/ES/PT lexicon
(`data/icp_lexicon.json` — tune it as new markets surface new noise; no code change).

Default behaviour is CONSERVATIVE: it removes only `off_icp` leads (dominant off-industry
signal, or a manufacturer that makes the product). `adjacent` (lab-relevant, distributor
language weak) and `uncertain` (thin/ambiguous — common abroad) are KEPT so we never drop
a real distributor on a thin site. Use --llm to escalate `uncertain` to a one-shot Claude
verdict for blurry international cases.

Usage:
  icp_classify.py <raw-batch.json> --country <C> [--discovery /tmp/<slug>.json]
                  [--drop off_icp[,adjacent]] [--llm] [--max-pages 3] [--dry-run]

Writes (in place): the raw batch, trimmed to kept verdicts, each lead tagged with
  icp_verdict / icp_reason / icp_signals / icp_match. Off-ICP leads -> vault/leads/off-icp/.
Manufacturer verdicts are appended to data/learned_off_icp.json so the next prepare pass
drops them pre-scrape. Per-seed outcomes (with --discovery) go to the tunnel ledger.
"""
import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
import qualify
from lead_guards import registrable_root

LEXICON_PATH = THIS_DIR / "data" / "icp_lexicon.json"
LEARNED_PATH = THIS_DIR / "data" / "learned_off_icp.json"
OFFICP_DIR = Path("/opt/velab/vault/leads/off-icp")
LEDGER_PATH = Path("/opt/velab/vault/leads/discovery-paths.jsonl")

KEEP_DEFAULT = {"distributor", "adjacent", "uncertain"}


def _load_lexicon():
    lex = json.loads(LEXICON_PATH.read_text(encoding="utf-8"))
    compiled = {
        "distributor": [re.compile(p, re.I) for p in lex["distributor"]],
        "lab": [re.compile(p, re.I) for p in lex["lab"]],
        "manufacturer": [re.compile(p, re.I) for p in lex["manufacturer"]],
        "negative": {k: [re.compile(p, re.I) for p in v] for k, v in lex["negative"].items()},
    }
    return lex.get("params", {}), compiled


def _matches(patterns, text, cap=6):
    """Distinct patterns that fire at least once + a few sample strings (for the audit)."""
    hits, samples = 0, []
    for rx in patterns:
        m = rx.search(text)
        if m:
            hits += 1
            if len(samples) < cap:
                samples.append(m.group(0).strip().lower()[:40])
    return hits, samples


def classify_text(text, params, lex):
    """Pure scoring on already-fetched site text -> verdict dict. No network."""
    low = text or ""
    lab_min = params.get("lab_min", 2)
    neg_thr = params.get("neg_threshold", 2)
    mfr_thr = params.get("mfr_threshold", 2)
    thin_chars = params.get("thin_text_chars", 600)

    lab_n, lab_s = _matches(lex["lab"], low)
    dist_n, dist_s = _matches(lex["distributor"], low)
    mfr_n, mfr_s = _matches(lex["manufacturer"], low)
    neg_by = {}
    for sub, pats in lex["negative"].items():
        n, s = _matches(pats, low)
        if n:
            neg_by[sub] = {"n": n, "samples": s}
    neg_sub, neg_strength, neg_samples = "", 0, []
    if neg_by:
        neg_sub = max(neg_by, key=lambda k: neg_by[k]["n"])
        neg_strength = neg_by[neg_sub]["n"]
        neg_samples = neg_by[neg_sub]["samples"]

    thin = len(low.strip()) < thin_chars
    signals = {"lab": lab_s, "distributor": dist_s, "manufacturer": mfr_s,
               "negative_subcat": neg_sub, "negative": neg_samples,
               "scores": {"lab": lab_n, "dist": dist_n, "mfr": mfr_n, "neg": neg_strength}}

    learn_hq = False
    if not low.strip():
        verdict, reason = "uncertain", "no readable site text (fetch failed/empty)"
    elif neg_strength >= neg_thr and (lab_n < lab_min or neg_strength > lab_n):
        # Off-industry signal dominates — either no lab relevance at all, OR the off-ICP
        # terms outweigh the lab words (catches directory/chamber pages like a CIG roster
        # that mention "distribuidor" but are really an industry chamber, not a buyer).
        verdict = "off_icp"
        reason = f"off-ICP: '{neg_sub}' signals dominate (neg={neg_strength} vs lab={lab_n})"
    elif mfr_n >= mfr_thr and dist_n == 0:
        verdict, learn_hq = "off_icp", True
        reason = "manufacturer / HQ (makes the product, does not buy) — learned"
    elif lab_n >= lab_min and dist_n >= 1:
        verdict, reason = "distributor", f"lab+distributor language (lab={lab_n}, dist={dist_n})"
    elif lab_n >= lab_min:
        verdict, reason = "adjacent", f"lab-relevant but distributor language weak (lab={lab_n}, dist={dist_n})"
    elif lab_n >= 1 or dist_n >= 1:
        verdict, reason = "uncertain", f"weak signal (lab={lab_n}, dist={dist_n})"
    elif neg_strength >= 1:
        verdict = "off_icp"
        reason = f"no lab relevance; '{neg_sub}' signals present"
    elif thin:
        verdict, reason = "uncertain", "thin site, no ICP signal either way"
    else:
        verdict, reason = "uncertain", "no lab/distributor signal, no clear off-ICP signal"
    return {"verdict": verdict, "reason": reason, "signals": signals, "learn_hq": learn_hq}


def _llm_verdict(host, ev):
    """Optional one-shot Claude escalation for an `uncertain` domain. Defensive: any
    failure falls back to the deterministic verdict (returns None)."""
    digest = {
        "host": host, "about": (ev.get("about_excerpt") or "")[:600],
        "scale_claims": ev.get("scale_claims"), "catalog_links": ev.get("catalog_links"),
        "client_roster": ev.get("client_roster_excerpt"),
        "text_sample": (ev.get("_fulltext") or "")[:1500],
    }
    prompt = (
        "You are an ICP classifier for Velab, which sells LABORATORY equipment (microscopes, "
        "balances, centrifuges, spectrophotometers) to DISTRIBUTORS and labs. Given this company's "
        "own website evidence, answer with EXACTLY ONE word: 'distributor' (sells/distributes lab or "
        "medical/diagnostic equipment), 'adjacent' (a lab/clinic/med-device firm, lab-relevant but not "
        "clearly a distributor), or 'off_icp' (anything else: law, logistics, EHS/occupational-health, "
        "retail/hardware, industrial automation, marketing/IT, manufacturer-HQ, consulting). "
        "Evidence:\n" + json.dumps(digest, ensure_ascii=False))
    try:
        r = subprocess.run(["claude", "-p", prompt], capture_output=True, text=True, timeout=90)
        out = (r.stdout or "").strip().lower()
        for v in ("distributor", "adjacent", "off_icp"):
            if v in out:
                return v
    except Exception:
        return None
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("batch", help="raw scrape batch JSON (list of lead dicts)")
    ap.add_argument("--country", required=True)
    ap.add_argument("--discovery", help="curated_discovery JSON (domain->via_seed) to attribute ledger yield")
    ap.add_argument("--drop", default="off_icp", help="comma verdicts to remove (default off_icp)")
    ap.add_argument("--llm", action="store_true", help="escalate 'uncertain' domains to a Claude verdict")
    ap.add_argument("--max-pages", type=int, default=3)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true", help="classify + report, do not modify files")
    a = ap.parse_args()

    params, lex = _load_lexicon()
    drop_set = {v.strip() for v in a.drop.split(",") if v.strip()}
    keep_set = KEEP_DEFAULT - drop_set

    leads = json.loads(Path(a.batch).read_text())
    if not isinstance(leads, list):
        leads = [leads]

    # domain -> via_seed (for ledger attribution)
    dom_seed = {}
    if a.discovery:
        try:
            doc = json.loads(Path(a.discovery).read_text())
            for c in doc.get("new_candidates", []):
                dom_seed[registrable_root(c.get("domain", ""))] = c.get("via_seed", "")
        except Exception:
            pass

    # One profile per unique registrable domain (cached).
    by_dom = defaultdict(list)
    for ld in leads:
        host = (ld.get("source_url") or ld.get("found_on_url") or ld.get("email", "")).strip()
        by_dom[registrable_root(host)].append(ld)
    domains = [d for d in by_dom if d]

    def _profile(dom):
        url = by_dom[dom][0].get("source_url") or f"https://{dom}/"
        try:
            ev = qualify.profile(url, max_pages=a.max_pages, include_text=True)
        except Exception as e:
            ev = {"_fulltext": "", "error": str(e)}
        verdict = classify_text(ev.get("_fulltext", ""), params, lex)
        if a.llm and verdict["verdict"] == "uncertain":
            lv = _llm_verdict(dom, ev)
            if lv:
                verdict = {**verdict, "verdict": lv, "reason": f"LLM verdict ({lv}); " + verdict["reason"],
                           "confidence": "llm"}
        verdict.setdefault("confidence", "deterministic")
        return dom, ev, verdict

    results = {}
    with ThreadPoolExecutor(max_workers=min(a.workers, max(1, len(domains)))) as ex:
        for dom, ev, verdict in ex.map(_profile, domains):
            results[dom] = (ev, verdict)

    kept, off, tally = [], [], defaultdict(int)
    learned_hq = []
    seed_outcome = defaultdict(lambda: defaultdict(int))
    for dom, members in by_dom.items():
        ev, verdict = results.get(dom, ({}, {"verdict": "uncertain", "reason": "not profiled",
                                             "signals": {}, "confidence": "deterministic"}))
        v = verdict["verdict"]
        tally[v] += len(members)
        seed = dom_seed.get(dom, "")
        seed_outcome[seed][v] += 1
        if verdict.get("learn_hq") and dom not in learned_hq:
            learned_hq.append(dom)
        for ld in members:
            ld["icp_verdict"] = v
            ld["icp_reason"] = verdict["reason"]
            ld["icp_signals"] = verdict.get("signals", {})
            ld["icp_confidence"] = verdict.get("confidence", "deterministic")
            ld["icp_match"] = v != "off_icp"
            (off if v in drop_set else kept).append(ld)

    report = {
        "batch": str(a.batch), "country": a.country,
        "domains_profiled": len(domains), "leads_in": len(leads),
        "verdicts": dict(tally),
        "kept": len(kept), "removed_off_icp": len(off),
        "reacher_calls_saved": len(off),
        "suggested_manufacturers": learned_hq,  # proposed for --learn confirmation, not auto-applied
        "dropped_verdicts": sorted(drop_set),
    }

    if a.dry_run:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    # 1) rewrite the raw batch with only kept verdicts (tagged in place)
    Path(a.batch).write_text(json.dumps(kept, ensure_ascii=False, indent=2))

    # 2) sidecar the removed off-ICP leads (never vanish silently)
    if off:
        OFFICP_DIR.mkdir(parents=True, exist_ok=True)
        stem = Path(a.batch).stem
        (OFFICP_DIR / f"{stem}-off-icp.json").write_text(json.dumps(off, ensure_ascii=False, indent=2))

    # 3) self-learning denylist. The classifier only SUGGESTS manufacturer domains
    # (-> "suggested_hq"); prepare_candidates does NOT auto-drop suggestions, so one
    # deterministic guess can never permanently blacklist a distributor-that-also-makes-
    # a-line. Only an operator/agent CONFIRMING a removal (`prepare_candidates --learn`)
    # writes the hard `manufacturer_hq`/`off_icp` buckets that auto-drop next pass.
    # (Removed-this-batch + sidecar'd regardless — this only governs PERSISTENT blacklisting.)
    if learned_hq:
        learned = {"manufacturer_hq": [], "off_icp": [], "suggested_hq": []}
        if LEARNED_PATH.exists():
            try:
                learned = json.loads(LEARNED_PATH.read_text())
            except Exception:
                pass
        learned.setdefault("suggested_hq", [])
        for d in learned_hq:
            if d not in learned["suggested_hq"] and d not in learned.get("manufacturer_hq", []):
                learned["suggested_hq"].append(d)
        LEARNED_PATH.write_text(json.dumps(learned, ensure_ascii=False, indent=2))

    # 4) close the ledger loop: per-seed ICP outcome (only when discovery map provided)
    if dom_seed and seed_outcome:
        try:
            LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
            import datetime
            today = datetime.date.today().isoformat()
            with LEDGER_PATH.open("a", encoding="utf-8") as f:
                for seed, vc in seed_outcome.items():
                    if not seed:
                        continue
                    f.write(json.dumps({
                        "type": "icp_outcome", "date": today, "seed": seed,
                        "country": a.country, "verdicts": dict(vc),
                        "icp_valid": vc.get("distributor", 0) + vc.get("adjacent", 0),
                        "off_icp": vc.get("off_icp", 0),
                    }, ensure_ascii=False) + "\n")
        except Exception as e:
            print(f"[ledger] warning: {e}", file=sys.stderr)

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
