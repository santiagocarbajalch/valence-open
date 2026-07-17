#!/usr/bin/env python3
"""identity.py — THE single identity module for the VELAB rebuild (2026-07-02 blueprint §1).

Every consumer (truth engine, certifier, archivist, gates, cold packs, console helpers)
imports company keys and entity classes from HERE. The audit found three divergent
regdom() implementations and per-consumer class logic — that class of bug ends at this file.

Two exported ideas:
  company_key(addr)  -> the ONE durable key: registrable domain, or the full mailbox
                        for freemail (two strangers at gmail.com are never one company).
  classify_identity(key, people, subjects) -> entity class:
        lead | institutional | vendor | probe | test | spam-batch | freemail-lead
     Classes exist so probes (mail-tester), operator tests, and junk batches can be
     derived OUT of worklists at the engine, instead of each surface re-filtering.
"""
import os
import re

# ---------------------------------------------------------------- company key
# Multi-label public suffixes seen in our geos (LatAm/Africa/SE-Asia + US institutional).
_TWO_LABEL = {"com", "co", "org", "net", "gov", "edu", "ind", "gob", "ac", "or", "in"}

FREEMAIL = {
    "gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "icloud.com",
    "aol.com", "live.com", "protonmail.com", "proton.me", "gmx.com", "mail.com",
    "hotmail.es", "outlook.es", "yahoo.es", "hotmail.com.mx", "live.com.mx",
    "yahoo.com.mx", "hotmail.com.br", "yahoo.com.br", "yandex.com",
}

# The system's own outbound sending domains — any address on one is "self", never
# a lead. Deployment sets the real domains via VELAB_SELF_DOMAINS (comma-separated);
# the defaults here are placeholders.
_SELF_DOMAINS = [d.strip() for d in
                 os.environ.get("VELAB_SELF_DOMAINS", "example.com,example-sales.com").split(",")
                 if d.strip()]
SELF_RX = re.compile(r"@(" + "|".join(re.escape(d) for d in _SELF_DOMAINS) + r")$", re.I)

_EMAIL_RX = re.compile(r"[\w.+\-']+@[\w.\-]+\.[A-Za-z]{2,}")


def email_of(s):
    """First email address inside an arbitrary header string, lowercased."""
    m = _EMAIL_RX.search(s or "")
    return m.group(0).lower() if m else ""


def registrable_domain(host):
    """foo.bar.com.co -> bar.com.co ; foo.bar.com -> bar.com ; bare host passthrough."""
    host = (host or "").lower().strip().strip(">")
    if host.startswith("www."):
        host = host[4:]
    p = host.split(".")
    if len(p) >= 3 and p[-2] in _TWO_LABEL:
        return ".".join(p[-3:])
    return ".".join(p[-2:]) if len(p) >= 2 else host


def company_key(addr):
    """The durable company key. Freemail mailboxes key by full address."""
    addr = (addr or "").lower().strip().strip(">")
    if "@" not in addr:
        return registrable_domain(addr)
    dom = registrable_domain(addr.split("@")[-1])
    return addr if dom in FREEMAIL else dom


def is_self(addr):
    return bool(SELF_RX.search(addr or ""))


# ---------------------------------------------------------------- noise / probes
NOISE_FROM = re.compile(
    r"(google\.com|tldv\.io|mailer-daemon|no-?reply|noreply|accounts\.google|"
    r"postmaster|microsoft\.com|atlassian|slack|calendly|notify|bounce)", re.I)

AUTOREPLY = re.compile(
    r"(out of office|fuera de la oficina|automatic reply|respuesta autom|"
    r"vacation|ausente|no estar[ée]|auto-?reply)", re.I)

# Junk cold-tool / SEO-scrape batch + deliverability probes (Phase-0 verified: 329RBFR
# on 109 junk domains, zero real leads).
SPAM_BATCH = re.compile(r"\b329RBFR\b|PlusVibe|\bSPF\s+DKIM\b|DKIM\s+DMARC|DMARC\s+Check", re.I)

# Deliverability / diagnostics endpoints — never leads, never work items (Phase-0 F6).
PROBE_KEYS = {"mail-tester.com", "glockapps.com", "mailgenius.com"}

# Machine reports + our own tools' transactional mail — a robot wrote, nobody to
# answer (2026-07-11, first-contact lane audit: 6 of the 8 inbound-only rows were
# DMARC aggregate-report robots and a sending-tool reactivation code).
SYSTEM_MAIL = re.compile(
    r"dmarc aggregate|aggregate report|report domain:|smtp tls report|"
    r"reactivation code|verification code", re.I)

# Operator-owned test identities (e2e wiring tests). The console's test-lead
# sandbox registers addresses via vault/pipeline/test-identities.json
# {"emails": [...]} — those addresses ride the REAL pipeline but never count as
# leads anywhere. A previously hardcoded operator test gmail was UN-hardcoded
# (operator ruling: a live quote = real deal; test class starved it of Archivist
# reads — class check runs before --force). The sandbox re-registers whatever
# address it seeds, so the test-lead flow is unaffected.
TEST_KEYS = set()
try:
    import json as _json
    TEST_KEYS |= {str(x).lower().strip() for x in
                  _json.load(open("/opt/velab/vault/pipeline/test-identities.json")).get("emails", [])}
except Exception:
    pass

INSTITUTIONAL = re.compile(
    r"\.(edu|gov|us)$|university|\bisd\b|k-12|college|school district|purchasing|procurement", re.I)


def classify_identity(key, subjects_blob="", texts_blob=""):
    """Entity class for a company key. Deterministic, engine-level — surfaces never re-filter.
    Order matters: explicit registries first, then content signals, then shape."""
    if key in TEST_KEYS:
        return "test"
    if key in PROBE_KEYS:
        return "probe"
    if SPAM_BATCH.search(subjects_blob or "") or SPAM_BATCH.search(texts_blob or ""):
        return "spam-batch"
    if SYSTEM_MAIL.search(subjects_blob or ""):
        return "system"
    if INSTITUTIONAL.search(key) or INSTITUTIONAL.search(texts_blob or ""):
        return "institutional"
    if "@" in key:  # freemail unit
        return "freemail-lead"
    return "lead"
