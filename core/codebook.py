#!/usr/bin/env python3
"""codebook.py — the ONE place machine codes become operator language (blueprint §4).
Company pages, INDEX, and books all render through here; the console mirrors these
strings in labels.ts. Never show a raw code on a human surface."""

STATE = {
    "question":             "They asked us a question",
    "info-request":         "They asked for information",
    "meeting-request":      "They want to meet",
    "meeting-outcome-due":  "Meeting happened — outcome not logged yet",
    "undelivered-ask":      "They asked for something we haven't sent",
    "declined-but-open":    "Said no, but left a door open",
    "replied-unclassified": "They replied — needs a human look",
    "promised-revert":      "They'll get back to us",
    "routed-internally":    "Forwarded inside their company",
    "awaiting-them":        "Their move — waiting on their reply",
    "declined":             "Declined (not confirmed closed)",
    "cold-no-reply":        "No reply yet to cold outreach",
    "opening":              "Showed interest",
    "inbound-only":         "They contacted us first",
}

BUCKET = {
    "owe":           "WE OWE THEM A REPLY",
    "owe-review":    "NEEDS A HUMAN LOOK",
    "awaiting":      "WAITING ON THEM",
    "institutional": "INSTITUTIONAL — vendor/procurement track",
    "cold":          "COLD OUTREACH",
    "inbound_only":  "INBOUND ONLY",
}

MEETING = {
    "scheduled":   "meeting on the calendar",
    "outcome-due": "meeting date passed — log the outcome",
    "held":        "meeting held",
}

SUPPRESSED = {
    "frozen": "FROZEN by operator decision",
    "closed": "CLOSED (operator-confirmed)",
    "dnc":    "Do-not-contact",
    "spam":   "Junk batch",
    "probe":  "Deliverability probe",
    "test":   "Internal test identity",
}

COLD_STEP = {  # legacy ladder codes -> plain language (survey G3)
    "COLD-01": "1st cold touch",
    "COLD-02": "2nd cold follow-up",
    "COLD-03": "3rd cold follow-up (final)",
    "COLD-03-FINAL": "3rd cold follow-up (final)",
    "MEETING-02-CONFIRM": "meeting confirmation",
}

def state_label(state):
    return STATE.get(state, state or "—")

def bucket_label(bucket):
    return BUCKET.get(bucket, bucket or "—")

def meeting_label(ms):
    return MEETING.get(ms, ms or "")

def suppressed_label(s):
    return SUPPRESSED.get(s, s or "")
