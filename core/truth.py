#!/usr/bin/env python3
"""truth.py — VELAB truth engine v2 (ground-up rebuild, blueprint 2026-07-02).

ONE pull (corpus shards) -> ONE key (identity.company_key) -> ONE persisted artifact
(vault/state/board.json). Every surface — /inbox-check, console, /draft, vault pages,
graph — is a VIEW of that artifact. Nothing downstream touches IMAP.

What this fixes vs company_state.py (audit refs in phase1-unified-critique.md):
  C1  unknown-ask now lands in `owe-review` (actionable), never passive awaiting
  C3  delivery is checked against the FULL outbound text, not a 400-char head
  C4  time transitions: an accepted meeting whose date passed -> meeting-outcome-due
  C5  identity classes derive probes/tests/spam OUT of worklists at the engine
  C6  threads are first-class sub-units — parallel workstreams stay visible
  B1  verdict join picks the NEWEST sibling verdict (file mtime), never a hash sort
  A3  the board is PERSISTED with history — consumers read, never re-derive

READ-ONLY vs the mailbox. Writes only vault/state/. Never sends, drafts, or stages.
"""
import argparse, json, os, re, sys, html as _html
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import identity as ident

TOOLS = Path("/opt/velab/workspace/tools")           # corpus shard layer (keep-list) lives here
sys.path.insert(0, str(TOOLS))
import corpus_store  # noqa: E402  — proven substrate, ported as-is for now

VAULT = Path("/opt/velab/vault")
STATE = VAULT / "state"
BOARD = STATE / "board.json"
HISTORY = STATE / "history"
HISTORY_KEEP = 40

FROZEN_FILE = VAULT / "pipeline/operator-frozen.json"
CLOSED_FILE = VAULT / "pipeline/closed.json"
DNC_FILE = VAULT / "suppression/dnc.jsonl"
MEETINGS_FILE = VAULT / "pipeline/meetings.json"
DIRECTIVES_FILE = VAULT / "pipeline/operator-directives.json"
DNC_MD = VAULT / "reference/dnc-domains.md"
VERDICTS = VAULT / "inbox/intel/verdicts"
ACTIVITY = VAULT / "inbox/intel/lead_activity.jsonl"

# ---------------------------------------------------------------- text helpers
_HTML_DROP = re.compile(r"(?is)<(script|style|head)\b.*?</\1>")
_HTML_BR = re.compile(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>")
_HTML_TAG = re.compile(r"<[^>]+>")

def html_to_text(h):
    if not h:
        return ""
    h = _HTML_DROP.sub(" ", h)
    h = _HTML_BR.sub("\n", h)
    t = _html.unescape(_HTML_TAG.sub("", h))
    return re.sub(r"\n\s*\n+", "\n", t).strip()

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
    return text[:m.start()] if m else text

_GREET_RX = re.compile(
    r"^\s*(estimad[oae]s?|buen[oa]s?\s*(d[ií]as|tardes|noches)?|hola|good\s*(day|morning|afternoon|evening)|"
    r"dear|hi|hello|cordial\s+saludo|reciba\s+un\s+cordial\s+saludo|apreciad[oae]s?)\b[^\n.:,]*[.:,]?\s*",
    re.I)

def gist(text, limit=150):
    """One-line plain gist: drop quoted history + greeting, first content sentence(s)."""
    t = strip_quoted(text or "").strip()
    prev = None
    while t and t != prev:
        prev = t
        t = _GREET_RX.sub("", t, count=1).lstrip(" ,.-\n\t")
    t = re.sub(r"\s+", " ", t).strip()
    if not t:
        return None
    if len(t) <= limit:
        return t
    cut = t[:limit]
    end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    if end >= 60:
        return cut[:end + 1].strip()
    sp = cut.rfind(" ")
    return (cut[:sp] if sp >= 60 else cut).strip() + "…"

# ---------------------------------------------------------------- signal lexicon
# Ported from the proven engine, with the audited gaps fixed (tuteo forms — the
# Gamma miss; C1 makes lexicon gaps non-fatal anyway: unknown ask -> owe-review).
SIG = {
    "meeting":  re.compile(r"agendar|coordinar (una|la|nuestra) reuni|disponibilidad para (una|la)? ?(reuni|llamada)|"
                           r"cu[aá]ndo (nos|podemos) (reun|llam)|env[ií]e(nos)? (el|la) (link|enlace|invitaci)|"
                           r"nos pueden? (enviar|confirmar) (el|la)? ?(link|enlace|horario|invitaci)|"
                           r"considera oportuna una reuni|propon(emos|go) (una|la) reuni|"
                           r"qu[eé] medio ser[ií]a la reuni|coordinar en tiempo real|"
                           r"confirmo mi disponibilidad", re.I),
    "ask_info": re.compile(r"\b(env[ií]e\w*|env[ií]ar\w*|comp[aá]rt\w*|facilit\w+|"
                           r"solicit\w+|quisiera|necesit\w+|requ(iero|erimos)|"
                           r"me gustar[ií]a recibir|podr[ií]as?(n)? (enviar|compartir|facilitar|hacer llegar))\b"
                           r".{0,40}\b(portafolio|cat[aá]logo|precios?|cotiz\w*|lista de precios|"
                           r"ficha\w*|especif\w*|informaci[oó]n|modelos?|brochure)\b", re.I),
    "question": re.compile(r"me podr[ií]as? (indicar|confirmar|ampliar|decir)|podr[ií]a(n|s)? (confirmar|ampliar|indicar)|"
                           r"cu[aá]ndo|qu[eé] medio|(tienen|cuentan con).{0,30}distribuidor|"
                           r"distribuidor en (el|su) pa[ií]s|han tenido experiencia|nos podr[ií]a|"
                           r"\?\s*$|\?\s+[A-ZÁÉÍÓÚ¿]", re.I | re.M),
    "close":    re.compile(r"no nos es posible|no podemos avanzar|compramos directo|directo (del|de) fabricante|"
                           r"otros proyectos|no estamos interesad|declin|no nos interesa|ya tenemos proveedor|"
                           r"ya contamos con|ya estamos trabajando|lo tendremos (presente|en cuenta)|"
                           r"no requerimos|por el momento (no|ya)|no es de nuestro inter|agradecemos.{0,40}no|"
                           r"ya no me encuentro trabajando|no laboro m[aá]s", re.I),
    "opening":  re.compile(r"no descartamos|en un futuro|considera oportuna|"
                           r"s[ií] (estamos|nos) interesa|suena genial|nos interesa(r[ií]a)?|"
                           r"seguimos (muy )?interesad", re.I),
    "ack":      re.compile(r"(se|ya) (envi|remiti|pas|reenvi).{0,30}(departamento|[aá]rea|ventas|direcci[oó]n|"
                           r"encargad|gerenc)|est[aá]n revisando|lo revisar|acusamos recibo|qued[oó] recibido", re.I),
    # they explicitly took the ball with a horizon ("regresamos en los próximos días") —
    # parked, not owe; not nudge-due until the promise horizon lapses.
    "promise":  re.compile(r"(regresamos|volvemos|le (respond|escrib)emos|nos pondremos en contacto|"
                           r"te (aviso|confirmo)|le confirmo)\b.{0,50}(d[ií]as?|semana|pr[oó]xim|pronto)|"
                           r"analizar\w*.{0,40}(oferta|propuesta|tema)", re.I),
}
REOPEN_SIGNALS = {"meeting", "ask_info", "question", "opening"}

DELIVER = {
    "invitación":  re.compile(r"(env[íi]\w*|mand\w*|nos pued\w* (enviar|mandar)|hac\w* llegar|"
                              r"comp[aá]rt\w*).{0,30}(invitaci[oó]n|invite)|"
                              r"invitaci[oó]n (de|al|a la|para).{0,15}(reuni|calendar|meet)|"
                              r"(el|un) link de (la )?reuni|remit\w+ la invitaci[oó]n", re.I),
    "cotización":  re.compile(r"\bcotiz\w*|presupuesto|solicito.{0,20}(cotiz|precio)", re.I),
    # request-verb REQUIRED for propuesta/contrato — a bare mention ("en relación con su
    # propuesta") is not an ask; the loose form false-flagged Delta/Orion.
    "propuesta":   re.compile(r"(env[íi]\w*|mand\w*|comp[aá]rt\w*|hac\w* llegar|remit\w*|"
                              r"solicit\w+|quisiera|necesit\w+).{0,40}propuesta", re.I),
    "contrato":    re.compile(r"(env[íi]\w*|mand\w*|comp[aá]rt\w*|hac\w* llegar|remit\w*|"
                              r"solicit\w+|quisiera|necesit\w+).{0,40}(contrato|convenio)", re.I),
    # request-verb REQUIRED — a bare noun is not an ask: "captura automática de los
    # pesos de las muestras" (a LIMS question) false-flagged ininlab into undelivered-ask.
    "muestras":    re.compile(r"(env[íi]\w*|mand\w*|comp[aá]rt\w*|hac\w* llegar|remit\w*|"
                              r"solicit\w+|quisiera|necesit\w+|interesa\w+ recibir|pued\w+ enviar)"
                              r".{0,40}\b(muestras?|demos?|samples?)\b", re.I),
    "fichas":      re.compile(r"ficha\w*.{0,10}t[ée]cnica|especificaci", re.I),
}
# what OUR outbound must contain to count as delivering X (checked on FULL text — C3)
DELIVERED = {
    "invitación":  re.compile(r"meet\.google\.com|invitaci[oó]n|calendar\.google|\.ics\b", re.I),
    "cotización":  re.compile(r"(US\$|USD|\$)\s?\d|cotizaci[oó]n adjunt|precios? unitari|lista de precios", re.I),
    "propuesta":   re.compile(r"propuesta|convenio adjunt|adjunt\w+ (la |el )?(propuesta|convenio)", re.I),
    "contrato":    re.compile(r"contrato|convenio", re.I),
    "muestras":    re.compile(r"demostraci[oó]n|equipos? de demo|muestras?", re.I),
    "fichas":      re.compile(r"ficha\w* t[ée]cnica|adjunt\w+.{0,20}ficha|especificacion", re.I),
}

_MODEL_RX = re.compile(r"\bVE[-\s]?\d{2,4}[A-Z]{0,3}\b", re.I)
_PRICE_RX = re.compile(r"(?:US\$|USD|\$|€)\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:USD|EUR|soles|pesos)\b", re.I)
_QTY_RX = re.compile(r"\b\d+\s?(?:unidades?|equipos?|microscopios?|balanzas?|cent[rí]fugas?|units?)\b", re.I)
_DOC_RX = re.compile(r"\b(cotizaci[oó]n|lista de precios|cat[aá]logo|propuesta|contrato|convenio|"
                     r"invitaci[oó]n|fichas?\s+t[eé]cnicas?|quote|price list|catalog(?:ue)?|proposal|contract)\b", re.I)

def _dedup(xs):
    seen, out = set(), []
    for x in xs:
        k = x.lower()
        if k not in seen:
            seen.add(k); out.append(x)
    return out

def key_facts(in_text, out_text):
    inb, out = strip_quoted(in_text or ""), strip_quoted(out_text or "")
    facts = {}
    models = _dedup([m.group(0).upper().replace(" ", "-") for m in _MODEL_RX.finditer(inb)])
    if models:
        facts["models_cited"] = models[:8]
    figs = _dedup([m.group(0).strip() for m in _PRICE_RX.finditer(inb)]
                  + [m.group(0).strip() for m in _QTY_RX.finditer(inb)])
    if figs:
        facts["figures_cited"] = figs[:6]
    docs = _dedup([m.group(0).lower() for m in _DOC_RX.finditer(out)])
    if docs:
        facts["doc_sent"] = docs[:6]
    return facts or None

# ---------------------------------------------------------------- calendar / time
ACCEPT_SUBJ = re.compile(r"^(aceptada?|accepted):", re.I)
DECLINED_SUBJ = re.compile(r"^(rechazada?|declined):", re.I)
# any Google-Calendar notice (accept/decline/updated invitation) — these carry the
# LEAD's From address but are machine mail: they must feed meeting signals, never
# "they wrote last" (the Beta REPLY-noise class, fixed 2026-07-07)
CAL_NOTICE_SUBJ = re.compile(
    r"^\s*(aceptada?|accepted|rechazada?|declined|invitaci[oó]n( actualizada)?|"
    r"(updated )?invitation)[:\s]", re.I)
# prose meeting confirmations, either direction (email-confirmed meetings are real
# meetings — calendar accepts alone missed spectralab's confirmed Jul-7)
_MEET_CONF_RX = re.compile(
    r"confirm\w+ (mi |nuestra |la |su )?(disponibilidad|asistencia|reuni[oó]n)|"
    r"confirmamos (nuestra |la )?reuni[oó]n|"
    r"reuni[oó]n (queda|quedar[ií]a|est[aá]) (agendada|acordada|confirmada|programada)|"
    r"(favor de |podr[ií]a\w* )?programar (para|la reuni[oó]n)|"
    r"(podr?emos|podemos) atender la reuni[oó]n", re.I)
_RESCHED_RX = re.compile(r"reprogramar|reagendar|posponer|aplazar|cancelar la reuni", re.I)
_NEWDATE_AFTER_RX = re.compile(r"programar\w*\s+para(\s+el|\s+la)?\s+", re.I)
_MONTHS = {"ene": 1, "feb": 2, "mar": 3, "abr": 4, "may": 5, "jun": 6, "jul": 7,
           "ago": 8, "sep": 9, "set": 9, "oct": 10, "nov": 11, "dic": 12,
           "jan": 1, "apr": 4, "aug": 8, "dec": 12}
# year OPTIONAL, "de" optional: prose confirmations say "martes 7 de julio a las 11:00"
# (the spectralab miss) — calendar accepts say "mié 1 jul 2026".
_DATE_RX = re.compile(r"\b(\d{1,2})\s+(?:de\s+)?(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic|"
                      r"jan|apr|aug|dec)\w*\.?(?:\s+(?:de\s+)?(\d{4}))?", re.I)
# numeric DD/MM (es locale): "programar para el miércoles 08/07" (the Beta reschedule)
_DATE_NUM_RX = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")

def _resolve_year(day, mon, year, today):
    try:
        if year:
            y = int(year)
            d = datetime(y + 2000 if y < 100 else y, mon, day).date()
        else:
            d = datetime(today.year, mon, day).date()
            if (today - d).days > 120:          # yearless date far in the past → they meant next year
                d = datetime(today.year + 1, mon, day).date()
        return d
    except Exception:
        return None

def parse_meeting_date(text, today):
    """First es/en date in a meeting notice/confirmation: 'D (de) mon (YYYY)' or DD/MM."""
    m = _DATE_RX.search(text or "")
    if m:
        return _resolve_year(int(m.group(1)), _MONTHS[m.group(2).lower()[:3]], m.group(3), today)
    m = _DATE_NUM_RX.search(text or "")
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        day, mon = (a, b) if b <= 12 else (b, a)    # DD/MM default; flip only when forced
        if mon <= 12 and 1 <= day <= 31:
            return _resolve_year(day, mon, m.group(3), today)
    return None

def bizdays_since(dstr, today):
    try:
        cur = datetime.fromisoformat((dstr or "")[:10]).date()
    except Exception:
        return None
    if cur >= today:
        return 0
    n = 0
    while cur < today:
        cur += timedelta(days=1)
        if cur.weekday() < 5:
            n += 1
    return n


def add_bizdays(dstr, n):
    """dstr + n business days -> date (the cadence next-due math, persisted so
    every surface can answer 'due when' — full-granularity audit 2026-07-09)."""
    try:
        cur = datetime.fromisoformat((dstr or "")[:10]).date()
    except Exception:
        return None
    while n > 0:
        cur += timedelta(days=1)
        if cur.weekday() < 5:
            n -= 1
    return cur

# Cadence (operator-specified 2026-07-03):
#   cold outreach (never replied)        → 3 business days between ladder touches
#   in-flight (they've replied at least once) → 2 business days
#   promised-revert ("regresamos en unos días") → 5 business days leash
#   post-meeting: a held meeting with silence since → owe/meeting-outcome-due the
#   NEXT business day (handled by the meeting transition, not a floor here)
COLD_LADDER_MAX = 3
COLD_DUE_BIZDAYS = 3
INFLIGHT_DUE_BIZDAYS = 2
PROMISED_REVERT_BIZDAYS = 5

# ---------------------------------------------------------------- registries (gated decisions)
# FAIL-LOUD: a registry that is PRESENT but unreadable/malformed must never be
# silently swallowed as an empty registry — that fail-open un-suppresses every
# frozen/DNC/closed company on the next derive (a DNC'd company could then be
# emailed). Absent file = legitimately empty (no alarm). Errors land in
# LOAD_ERRORS -> board.meta.load_errors -> the Auditor -> the digest.
LOAD_ERRORS = []
def _reg_error(name, path, exc):
    present = False
    try:
        present = os.path.exists(path)
    except Exception:
        pass
    if present:
        LOAD_ERRORS.append(f"{name}: {type(exc).__name__}: {str(exc)[:120]}")

def load_frozen():
    try:
        f = json.load(open(FROZEN_FILE))
        items = f.get("frozen", []) if isinstance(f, dict) else f
        out = {}
        for e in items:
            if isinstance(e, dict) and e.get("domain"):
                out[ident.company_key(e.get("email") or e["domain"])] = e
        return out
    except Exception as e:
        _reg_error("operator-frozen.json", FROZEN_FILE, e)
        return {}

def load_directives():
    """Operator directives (V4.2): holds + personal. Keyed by company_key like
    every registry. These NEVER change buckets — the whose-turn certifier is
    bucket-level and buckets must stay true. They stamp row fields the canonical
    view re-sections on (held / personal), so both the markdown board and the
    cockpit inherit them from ONE place."""
    holds, personal = {}, {}
    try:
        reg = json.load(open(DIRECTIVES_FILE))
        for e in reg.get("holds", []):
            ref = e.get("email") or e.get("domain")
            if isinstance(e, dict) and ref and e.get("until"):
                holds[ident.company_key(ref)] = e
        for e in reg.get("personal", []):
            ref = e.get("email") or e.get("domain")
            if isinstance(e, dict) and ref:
                personal[ident.company_key(ref)] = e
    except Exception as e:
        _reg_error("operator-directives.json", DIRECTIVES_FILE, e)
    return holds, personal

def _hold_active(hold, today, li_d):
    """The hold's until-date if it is live: today < until AND no inbound arrived
    after the hold was placed (a reply always voids a hold — it re-surfaces the
    row so an owed answer can never sit hidden behind a pacing directive)."""
    if not hold or not hold.get("until"):
        return None
    if hold["until"] <= today.isoformat():
        return None
    if li_d and li_d > (hold.get("ts") or ""):
        return None
    return hold["until"]

def load_meetings():
    """Newest INVITED registry meeting per company key (status=="invited" only —
    the invite actually fired at operator GO). vault/pipeline/meetings.json is
    written by create_meeting.py; a merely-held event is NOT board truth (the
    2026-07-08 Orion phantom: a stale Jul-4 held event read as
    'scheduled, invite not sent' and prompted an invite the client never asked
    for). Key = company_key of the first non-velab attendee."""
    try:
        reg = json.load(open(MEETINGS_FILE))
        newest = {}
        for m in reg.get("meetings", []):
            if not isinstance(m, dict):
                continue
            key = None
            for a in m.get("attendees") or []:
                a = (a or "").lower()
                if a and "@" in a and not ident.is_self(a):
                    key = ident.company_key(a)
                    break
            if not key:
                continue
            # newest entry per key by UPDATED stamp (not start): a cancellation
            # must TOMBSTONE any older sibling hold/invite for the same company —
            # the Orion twin resurrection (2026-07-08): cancelling the
            # newer hold let a stale Jul-4 hold win on `start` ordering.
            stamp = m.get("updated") or m.get("created") or m.get("start") or ""
            if key not in newest or stamp > newest[key][0]:
                newest[key] = (stamp, m)
        # ONLY "invited" events are board truth (operator ruling 2026-07-08, the
        # Orion phantom): a "held" event is an internal tentative slot
        # the client has NEVER been notified of — it must not flip the row to
        # scheduled nor generate a "send calendar invite" prompt. Client-
        # confirmed meetings without an invite are still caught by the corpus
        # prose-confirmation path. Cancelled newest = hard tombstone.
        return {k: m for k, (_, m) in newest.items()
                if (m.get("status") or "").strip().lower() == "invited"}
    except Exception as e:
        _reg_error("meetings.json", MEETINGS_FILE, e)
        return {}


def load_closed():
    try:
        c = json.load(open(CLOSED_FILE))
        rows = c.get("closed", c) if isinstance(c, dict) else c
        out = {}
        if isinstance(rows, dict):
            for k, v in rows.items():
                out[ident.company_key(k)] = v if isinstance(v, dict) else {"closed_on": str(v)}
        elif isinstance(rows, list):
            for e in rows:
                if isinstance(e, dict) and e.get("domain"):
                    out[ident.company_key(e["domain"])] = e
        return out
    except Exception as e:
        _reg_error("closed.json", CLOSED_FILE, e)
        return {}

def load_dnc():
    """(domains, emails) — email row = email-level kill; domainless row / md Active list = domain kill."""
    doms, emails = set(), set()
    try:
        for line in open(DNC_FILE):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("email"):
                emails.add(r["email"].lower())
            elif r.get("domain"):
                doms.add(ident.company_key(r["domain"]))
    except Exception as e:
        _reg_error("dnc.jsonl", DNC_FILE, e)
    try:
        active = False
        for line in open(DNC_MD):
            s = line.strip()
            if s.startswith("## Active DNC"):
                active = True; continue
            if s.startswith("## ") and "Active DNC" not in s:
                active = False
            if active:
                for d in re.findall(r"`([\w.-]+\.\w+)`", s):
                    doms.add(ident.company_key(d))
    except Exception as e:
        _reg_error("dnc-domains.md", DNC_MD, e)
    return doms, emails

VERDICTS2 = VAULT / "inbox/intel/verdicts2"

def load_verdicts():
    """Company-keyed Archivist v2 verdicts win; legacy per-address files are a fallback
    joined by newest MTIME across siblings (fixes B1 wrong-sibling)."""
    best = {}
    try:
        for p in VERDICTS.glob("*.json"):
            try:
                v = json.loads(p.read_text())
            except Exception:
                continue
            k = ident.company_key(v.get("email") or p.stem.replace("_", "@", 1))
            mt = p.stat().st_mtime
            if k not in best or mt > best[k][0]:
                best[k] = (mt, v)
    except Exception:
        pass
    out = {k: dict(v[1], _verdict_mtime=datetime.fromtimestamp(v[0], timezone.utc).isoformat())
           for k, v in best.items()}
    try:
        for p in VERDICTS2.glob("*.json"):
            if p.name == "manifest.json":
                continue
            try:
                v = json.loads(p.read_text())
            except Exception:
                continue
            k = ident.company_key(v.get("company") or "")
            if k:
                out[k] = dict(v, _verdict_mtime=v.get("read_at"))
    except Exception:
        pass
    return out

def load_notes():
    notes = {}
    try:
        for line in open(ACTIVITY):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            k = ident.company_key(r.get("domain") or "")
            if k:
                notes.setdefault(k, []).append(r)
    except Exception as e:
        _reg_error("lead_activity.jsonl", ACTIVITY, e)
    for k in notes:
        notes[k].sort(key=lambda r: r.get("ts") or "", reverse=True)
    return notes

# ---------------------------------------------------------------- threads
_SUBJ_PREFIX = re.compile(r"^\s*((re|rv|fw|fwd|aceptada?|accepted|rechazada?|declined|invitaci[oó]n actualizada|updated invitation)\s*:\s*)+", re.I)

def thread_key(subject):
    s = _SUBJ_PREFIX.sub("", (subject or "").strip()).strip().lower()
    return re.sub(r"\s+", " ", s) or "(no subject)"

def genuine_inbound(m):
    fr = ident.email_of(m.get("from", ""))
    if not fr or ident.is_self(fr) or ident.NOISE_FROM.search(m.get("from") or ""):
        return False
    if CAL_NOTICE_SUBJ.search(m.get("subject", "") or ""):
        return False  # calendar machine-mail: meeting signal yes, "they wrote last" no
    blob = (m.get("subject", "") or "") + " " + body_of(m)[:400]
    return not ident.AUTOREPLY.search(blob)

# ---------------------------------------------------------------- the derivation
def derive(today=None):
    today = today or datetime.now(timezone.utc).date()
    LOAD_ERRORS.clear()   # per-derive; a stale error from a prior run must not linger
    allmail, sent, newest = corpus_store.load_shards()
    degraded = not allmail
    corpus_age_min = None
    if newest:
        corpus_age_min = int((datetime.now(timezone.utc) - datetime.fromisoformat(newest)).total_seconds() / 60)

    frozen, closed, (dnc_doms, dnc_emails) = load_frozen(), load_closed(), load_dnc()
    meetings_reg = load_meetings()
    verdicts, notes = load_verdicts(), load_notes()
    holds_reg, personal_reg = load_directives()

    # fold + dedup by messageId. SEND-BOX TRUTH: a self-authored message counts
    # as outbound ONLY if Enviados carries it — All Mail includes Borradores, so
    # staged-then-purged drafts otherwise masquerade as sends and shift every
    # last_out/touch/cadence date (the 2026-07-07 phantom-send audit: 11 rows).
    sent_ids = {m.get("messageId") for m in sent if m.get("messageId")}
    seen, msgs = set(), []
    for m in list(allmail) + list(sent):
        mid = m.get("messageId")
        if mid and mid in seen:
            continue
        if mid and mid not in sent_ids and ident.is_self(ident.email_of(m.get("from", ""))):
            continue  # self-authored, never in Enviados = a draft, not a send
        if mid:
            seen.add(mid)
        msgs.append(m)

    # ---- spam-folder overlay (audit 2026-07-09): All Mail EXCLUDES [Gmail]/Spam,
    # so two blind spots existed: (a) DSN bounces for our own sends — the touch
    # counted but never arrived; (b) a real lead reply Gmail misroutes to Spam —
    # permanently invisible. Spam is captured by corpus_pull into shard["spam"]
    # and folded here CONSERVATIVELY: spam mail can only ANNOTATE or surface into
    # companies that already exist from All-Mail/Sent — junk can never mint a company.
    spam_msgs = corpus_store.load_spam()
    _DSN_FROM = re.compile(r"mailer-daemon|postmaster", re.I)
    _DSN_SUBJ = re.compile(r"delivery status|undeliver|no se pudo entregar|devuelto", re.I)

    # cross-TLD conversation aliasing (2026-07-08 audit, extended 2026-07-10):
    # outreach to foo.CL answered from foo.COM split into two company keys.
    # v1 folded INBOUND only, by looking up references in a map of OUR send mids —
    # which missed the outbound direction: our 2026-07-10 reply to the .com
    # sibling minted a phantom margaritamorales.com cold company while the
    # engaged .cl key stayed nudge-due. Worse, the reply's References chain was
    # truncated to just their Outlook mid, so a one-hop lookup could never fold it.
    # v2 (2026-07-10): walk messages in CHRONOLOGICAL order and map EVERY resolved
    # message's mid -> its final company key. References always point backward in
    # time, so any message (ours or theirs) that references a sibling-brand
    # conversation folds into it — transitively, surviving truncated chains.
    # The guard is unchanged: keys must share the brand label (same company).
    companies = {}
    mid2key = {}
    for m in sorted(msgs, key=lambda x: x.get("date") or ""):
        fr, to = ident.email_of(m.get("from", "")), ident.email_of(m.get("to", ""))
        inbound = not ident.is_self(fr)
        cp = fr if inbound else to
        if not cp or ident.is_self(cp) or ident.NOISE_FROM.search(cp):
            continue
        # email-level DNC is a SEND block, never a read block (audit 2026-07-08:
        # the old `continue` here erased whole companies — leegov + 15
        # reacher-invalid kills — and would swallow a customer's future reply).
        # History folds; send paths keep enforcing dnc_emails as targets.
        key = ident.company_key(cp)
        if not key or ident.NOISE_FROM.search(key):
            continue
        refs = m.get("references") or []
        if isinstance(refs, str):          # some records carry the raw header string
            refs = refs.split()
        for r in [m.get("inReplyTo")] + list(refs):
            ak = mid2key.get(r)
            if ak and ak != key and ak.split(".")[0] == key.split(".")[0]:
                key = ak
                break
        if m.get("messageId"):
            mid2key[m["messageId"]] = key
        c = companies.setdefault(key, {"key": key, "msgs": [], "people": set()})
        rec = {"date": (m.get("date") or "")[:16], "inbound": inbound,
               "from": fr, "to": to, "subj": m.get("subject") or "", "text": body_of(m)}
        c["msgs"].append(rec)
        if inbound and genuine_inbound(m):
            c["people"].add(fr)

    # spam-folder fold (see overlay note above): DSNs -> per-company bounce marks;
    # non-DSN mail from a KNOWN company key -> folds as normal inbound (a misrouted
    # real reply must surface — it rides the same genuine_inbound gates as All-Mail).
    bounces, spam_folded = {}, set()
    for m in spam_msgs:
        fr = ident.email_of(m.get("from", ""))
        subj = m.get("subject") or ""
        if _DSN_FROM.search(m.get("from") or "") or _DSN_SUBJ.search(subj):
            for addr in set(ident._EMAIL_RX.findall(body_of(m))):
                addr = addr.lower()
                if ident.is_self(addr) or _DSN_FROM.search(addr):
                    continue
                k = ident.company_key(addr)
                if k in companies:
                    bounces.setdefault(k, []).append(
                        {"date": (m.get("date") or "")[:16], "to": addr})
            continue
        if not fr or ident.is_self(fr) or ident.NOISE_FROM.search(fr):
            continue
        k = ident.company_key(fr)
        if k not in companies:
            continue  # junk can never mint a company
        c = companies[k]
        rec = {"date": (m.get("date") or "")[:16], "inbound": True,
               "from": fr, "to": ident.email_of(m.get("to", "")),
               "subj": subj, "text": body_of(m)}
        c["msgs"].append(rec)
        spam_folded.add(k)
        if genuine_inbound(m):
            c["people"].add(fr)

    out = []
    for key, c in companies.items():
        ms = sorted(c["msgs"], key=lambda x: x["date"])
        subj_blob = " ".join(x["subj"] for x in ms[-40:])
        text_blob = " ".join(x["text"][:400] for x in ms[-20:])
        klass = ident.classify_identity(key, subj_blob, text_blob)

        outbound = [x for x in ms if not x["inbound"]]
        gen_in = [x for x in ms if x["inbound"] and genuine_inbound(
            {"from": x["from"], "subject": x["subj"], "text": x["text"]})]
        # DEAD MAILBOX: every address we send to is email-level DNC'd or has hard-
        # bounced (bounces land in dnc.jsonl as email rows). The cold pack already
        # skips these (skipped_dnc), so counting them as "cold due" made the board
        # lie — the known open item "cold_due counts DNC'd dead mailboxes". They
        # get their own substate so the count stays honest (count = filter) and
        # they stay VISIBLE as dead rather than silently dropped.
        _targets = {x["to"] for x in outbound if x.get("to")}
        dead_mailbox = bool(_targets and dnc_emails and _targets <= dnc_emails)

        # ---- thread sub-units (C6)
        threads = {}
        for x in ms:
            tk = thread_key(x["subj"])
            t = threads.setdefault(tk, {"subject": tk, "msgs": []})
            t["msgs"].append(x)
        thread_rows = []
        for tk, t in threads.items():
            tin = [x for x in t["msgs"] if x["inbound"] and genuine_inbound(
                {"from": x["from"], "subject": x["subj"], "text": x["text"]})]
            tout = [x for x in t["msgs"] if not x["inbound"]]
            li, lo = (tin[-1] if tin else None), (tout[-1] if tout else None)
            # calendar accepts/declines are notifications, never asks — reading
            # "aceptó esta invitación" as an invite REQUEST was a v1 false-positive.
            askable = [x for x in tin[-3:] if not ACCEPT_SUBJ.search(x["subj"])
                       and not DECLINED_SUBJ.search(x["subj"])]
            asked = sorted({d for x in askable for d, rx in DELIVER.items()
                            if rx.search(strip_quoted(x["text"]))})
            delivered, missing = [], []
            for d in asked:
                ask_date = max(x["date"] for x in askable
                               if DELIVER[d].search(strip_quoted(x["text"])))
                # FULL-text delivery check on outbound AFTER the ask (C3)
                ok = any(DELIVERED[d].search(x["text"]) for x in tout if x["date"] >= ask_date)
                (delivered if ok else missing).append(d)
            thread_rows.append({
                "subject": tk,
                "last_in": li and {"date": li["date"], "from": li["from"], "gist": gist(li["text"])},
                "last_out": lo and {"date": lo["date"], "gist": gist(lo["text"])},
                "open": bool(li and (not lo or li["date"] > lo["date"])) or bool(missing),
                "asked": asked, "delivered": delivered, "missing": missing,
            })
        thread_rows.sort(key=lambda t: max((t["last_in"] or {}).get("date", ""),
                                           (t["last_out"] or {}).get("date", "")), reverse=True)

        last_out = outbound[-1] if outbound else None
        last_in = gen_in[-1] if gen_in else None
        li_d = last_in["date"] if last_in else ""
        lo_d = last_out["date"] if last_out else ""
        them_last = bool(last_in and li_d > lo_d)
        sigs = set()
        if last_in:
            blob = last_in["subj"] + "\n" + strip_quoted(last_in["text"])
            sigs = {k for k, rx in SIG.items() if rx.search(blob)}

        # company-level missing deliverables (any open thread)
        missing_all = sorted({d for t in thread_rows for d in t["missing"]})

        # ---- meeting detection + time transition (C4, rebuilt 2026-07-03)
        # The NEWEST meeting-signal message wins, scanning BOTH directions:
        #   calendar accepts ("Aceptada: … mié 1 jul 2026") AND prose confirmations
        #   ("confirmo mi disponibilidad para el martes 7 de julio" — the spectralab
        #   miss; "favor de programar para el miércoles 08/07" — the Beta resched).
        # A newer reschedule notice without a new date VOIDS the old acceptance
        # (state "rescheduling") instead of leaving a stale scheduled/outcome-due date.
        # outcome-due ONLY when the meeting date passed AND neither side spoke since.
        meeting_at, meeting_state, meeting_invite_sent = None, None, None
        best_msg_date, won_accept = None, False
        for x in reversed(ms):
            subj, body = x["subj"], strip_quoted(x["text"])[:800]
            if DECLINED_SUBJ.search(subj):
                continue
            accept = x["inbound"] and ACCEPT_SUBJ.search(subj)
            # confirmation must be INBOUND (audit 2026-07-08): our own outbound
            # "podríamos programar para el viernes 10/07" is a PROPOSAL — matching
            # it minted phantom scheduled meetings + invite prompts from our own
            # words. Reschedules stay bidirectional (safety-side: they only void).
            conf = x["inbound"] and _MEET_CONF_RX.search(body)
            resched = _RESCHED_RX.search(body)
            if not (accept or conf or resched):
                continue
            won_accept = bool(accept)
            if resched and not accept:
                # only a date explicitly proposed AFTER "(re)programar para …" counts as
                # the new meeting — the first date in a resched note is the CANCELLED one
                mn = _NEWDATE_AFTER_RX.search(body)
                d = parse_meeting_date(body[mn.end():mn.end() + 60], today) if mn else None
                if d:
                    meeting_at, best_msg_date = d, x["date"]
                else:
                    meeting_state, best_msg_date = "rescheduling", x["date"]
                break
            d = parse_meeting_date(subj + " " + body, today)
            if d:
                meeting_at, best_msg_date = d, x["date"]
                break
        if meeting_state == "rescheduling" and best_msg_date:
            # a dateless reschedule notice decays: past the promised-revert floor
            # (5bd) it is no longer an active reschedule — the company is just a
            # normal awaiting/in-flight row and must leave the meetings strip
            # (the Vega wrong-read, 2026-07-06)
            bd = bizdays_since(best_msg_date, today)
            if bd is None or bd > 5:
                meeting_state = None
        if meeting_at:
            md = meeting_at.isoformat()
            # same-day counts as spoken: corpus meetings carry a date, not a time,
            # so a wrap-up sent hours after the call still lands ON meeting day
            # (the spectralab wrong-read, 2026-07-08: thank-you+price-list at 17:34
            # after an 11:00 meeting left the row "outcome-due"). If the same-day
            # message was in fact pre-meeting, nothing is lost — the 3bd follow-up
            # cadence still surfaces the quiet thread; only the false "passed in
            # silence" prompt dies.
            spoke_after = (li_d and li_d[:10] >= md) or (lo_d and lo_d[:10] >= md)
            if meeting_at >= today:
                meeting_state = "scheduled"
            elif not spoke_after:
                meeting_state = "outcome-due"
            else:
                meeting_state = "held"
            if meeting_state == "scheduled":
                # did the calendar invite / Meet link actually go out after the confirmation?
                # A calendar ACCEPT as the winning signal PROVES the invite exists —
                # (the Beta false alarm, 2026-07-06: their accept became the newest
                # meeting signal and no outbound follows an acceptance)
                meeting_invite_sent = won_accept or any(
                    DELIVERED["invitación"].search(x["text"])
                    for x in outbound if x["date"] >= best_msg_date)

        # ---- meetings registry overlay (V4.1 Phase 2, narrowed 2026-07-08): only
        # an INVITED event (invite fired at operator GO) is truth the corpus can't
        # see yet. Registry wins UNLESS the mailbox produced newer meeting evidence
        # (reschedule/decline after the invite) — newest info wins.
        meeting_source = "corpus" if (meeting_at or meeting_state) else None
        reg_m = meetings_reg.get(key)
        if reg_m:
            reg_start = (reg_m.get("start") or "")[:10]
            corpus_newer = bool(best_msg_date and
                                best_msg_date[:16] > (reg_m.get("updated") or "")[:16])
            try:
                reg_date = datetime.fromisoformat(reg_start).date()
            except Exception:
                reg_date = None
            if reg_date and not corpus_newer:
                meeting_at = reg_date
                if reg_date >= today:
                    meeting_state = "scheduled"
                    meeting_invite_sent = reg_m.get("status") == "invited"
                else:
                    # same-day counts as spoken — same rule as the corpus path above
                    spoke_after = (li_d and li_d[:10] >= reg_start) or (lo_d and lo_d[:10] >= reg_start)
                    meeting_state = "held" if spoke_after else "outcome-due"
                meeting_source = "registry"
        meeting_meet_url = (reg_m or {}).get("meet_url") if meeting_source == "registry" else None
        meeting_event_id = (reg_m or {}).get("event_id") if meeting_source == "registry" else None

        v = verdicts.get(key) or {}
        touches = len(outbound)
        bd_out = bizdays_since(lo_d, today)

        # ---- state machine
        suppressed = None
        if klass == "spam-batch":
            suppressed = "spam"
        elif klass == "probe":
            suppressed = "probe"
        elif klass == "system":
            suppressed = "system"   # machine reports (DMARC robots, tool codes) — nobody to answer
        # klass == "test" is NOT suppressed (operator ruling 2026-07-04): a mail
        # from a registered test identity is a live TEST work item — it rides the
        # board like a real lead (TEST-tagged in the UI) so the whole reply loop
        # can be driven end-to-end on the operator's own address. Test companies
        # never enter the cold ladder or the close-out suggestions (below).
        elif key in dnc_doms:
            suppressed = "dnc"
        elif key in frozen:
            suppressed = "frozen"
        elif key in closed:
            closed_on = (closed[key].get("closed_on") or "")[:10]
            if not (li_d and li_d[:10] > closed_on and (sigs & REOPEN_SIGNALS)):
                suppressed = "closed"   # re-open guard (Delta rule) otherwise falls through LIVE

        # ---- PINGED: a suppressed lead that just wrote back with a live signal.
        # Operator intent (operator-frozen.json _meta): a freeze STAYS sticky — a
        # fresh reply must NOT silently re-enter the actionable funnel — but it is
        # NOT allowed to vanish either. Instead it is surfaced to the operator's
        # eyes in a dedicated tray. This is the `operator_frozen_pinged` mechanism
        # the v1 engine (retired inbox_view.py) owned and the v2 rewrite dropped —
        # the acme-labs.example.com class (frozen 07-06, hot pricing ask 07-11, invisible).
        # Gate: reply is NEWER than the suppression decision (the operator has not
        # seen it) AND carries a genuine re-open signal AND they hold the ball.
        pinged, pinged_reason = False, None
        if suppressed in ("frozen", "closed", "dnc") and them_last and li_d and (sigs & REOPEN_SIGNALS):
            if suppressed == "frozen":
                supp_on = ((frozen.get(key) or {}).get("frozen_on") or "")[:10]
            elif suppressed == "closed":
                supp_on = ((closed.get(key) or {}).get("closed_on") or "")[:10]
            else:
                supp_on = ""   # dnc has no reliable date; any live reply on a DNC'd lead is worth a look
            if not supp_on or li_d[:10] > supp_on:
                pinged = True
                _sig = "asked for info" if "ask_info" in sigs else \
                       "meeting" if "meeting" in sigs else \
                       "a question" if "question" in sigs else "re-engaged"
                pinged_reason = f"replied {li_d[:10]} ({_sig}) after {suppressed} {supp_on or '—'}"

        if not outbound and klass == "test":
            # test identity writing in first: still a work item (simulated customer)
            bucket, state = "owe-review", "replied-unclassified"
        elif not outbound:
            bucket, state = "inbound_only", "inbound-only"
        elif not gen_in:
            bucket = "cold"
            state = "cold-no-reply"
        elif meeting_state == "outcome-due":
            bucket, state = "owe", "meeting-outcome-due"
        elif them_last:
            if sigs & {"ask_info"}:
                bucket, state = "owe", "info-request"
            elif sigs & {"meeting"}:
                bucket, state = "owe", "meeting-request"
            elif (sigs & {"close"}) and (sigs & {"opening"}):
                bucket, state = "owe", "declined-but-open"
            elif sigs & {"question"}:
                bucket, state = "owe", "question"
            elif sigs & {"opening"}:
                bucket, state = "owe", "opening"
            elif (sigs & {"close"}) and not (sigs & REOPEN_SIGNALS):
                bucket, state = "awaiting", "declined"      # parked + proposed close below
            elif "ack" in sigs:
                bucket, state = "awaiting", "routed-internally"
            elif "promise" in sigs:
                bucket, state = "awaiting", "promised-revert"          # parked: they took the ball
            else:
                bucket, state = "owe-review", "replied-unclassified"   # C1: unknown = ACTIONABLE
        else:
            bucket, state = "awaiting", "awaiting-them"
        if missing_all and bucket in ("awaiting", "owe-review"):
            bucket, state = "owe", "undelivered-ask"        # asked for X, we never sent X
        if klass == "institutional" and bucket in ("owe", "owe-review", "awaiting"):
            bucket = "institutional"

        # promised-revert gets a longer leash (their stated horizon) before nudging
        _fu_floor = {"promised-revert": PROMISED_REVERT_BIZDAYS}.get(state, INFLIGHT_DUE_BIZDAYS)
        followup_due = bool(gen_in and not them_last and state != "routed-internally"
                            and klass != "institutional"        # Licitador's lane, never nudged
                            and (bd_out or 0) >= _fu_floor)
        # next_due: the DATE the cadence floor lands (full-granularity audit
        # 2026-07-09 — 'which ladder step, due when' was unanswerable on every
        # surface). Warm rows: last_out + floor; cold: last_out + cold cadence.
        next_due = None
        if bucket == "cold" and klass != "test" and touches < COLD_LADDER_MAX and not dead_mailbox:
            next_due = add_bizdays(lo_d, COLD_DUE_BIZDAYS)
        elif (gen_in and not them_last and state != "routed-internally"
              and klass != "institutional"):
            next_due = add_bizdays(lo_d, _fu_floor)
        cold_sub = None
        if bucket == "cold" and klass == "test":
            cold_sub = "not_due"   # test identities never enter the templated ladder
        elif bucket == "cold":
            if dead_mailbox:
                cold_sub = "dead"   # undeliverable — every target DNC'd/bounced
            elif touches >= COLD_LADDER_MAX:
                cold_sub = "exhausted"
            elif bd_out is not None and bd_out >= COLD_DUE_BIZDAYS:
                cold_sub = "due"
            else:
                cold_sub = "not_due"

        # decline verdict / regex agreement -> proposed close (operator-gated, never auto)
        v_sig = v.get("stage_signal") or ""
        propose_close = bool(not suppressed and klass != "test" and (
            (state == "declined") or v_sig in ("not-interested", "closed-lost"))
            and not (sigs & REOPEN_SIGNALS))

        # ---- events timeline (deduped)
        events, seen_ev = [], set()
        for x in ms[-30:]:
            g = gist(x["text"]) or x["subj"]
            ek = (x["date"][:10], "in" if x["inbound"] else "out", (g or "")[:60])
            if ek in seen_ev:
                continue
            seen_ev.add(ek)
            events.append({"date": x["date"], "dir": "in" if x["inbound"] else "out",
                           "who": x["from"] if x["inbound"] else "us", "gist": g})
        for n in (notes.get(key) or [])[:10]:
            events.append({"date": (n.get("ts") or "")[:16], "dir": "note",
                           "who": n.get("by") or "operator", "gist": n.get("note")})
        events.sort(key=lambda e: e["date"] or "", reverse=True)

        out.append({
            "key": key, "class": klass, "people": sorted(c["people"]),
            "bucket": bucket, "state": state, "suppressed": suppressed,
            "them_last": them_last, "signals": sorted(sigs),
            "last_in_date": li_d, "last_in_from": last_in["from"] if last_in else None,
            # 280-char gists (was 150): the ledger showed "a clip of a clip" —
            # full-granularity audit 2026-07-09. Thread bodies stay the deep read.
            "last_in_gist": gist(last_in["text"], 280) if last_in else None,
            "last_in_subj": last_in["subj"] if last_in else None,
            "last_out_date": lo_d,
            "last_out_gist": gist(last_out["text"], 280) if last_out else None,
            "touches": touches, "replies_count": len(gen_in),
            "bizdays_since_out": bd_out,
            "followup_due": followup_due, "cold_substate": cold_sub,
            "dead_mailbox": dead_mailbox,
            "next_due": next_due.isoformat() if next_due else None,
            # spam-folder findings (audit 2026-07-09): DSN bounces mean the touch
            # never arrived; spam_inbound means Gmail misrouted their mail — both
            # render as loud cautions, neither silently alters cadence math (v1:
            # surface first, operator decides).
            "bounces": bounces.get(key) or None,
            "spam_inbound": key in spam_folded,
            "deliverables_missing": missing_all,
            "meeting_at": meeting_at.isoformat() if meeting_at else None,
            "meeting_state": meeting_state,
            "meeting_invite_sent": meeting_invite_sent,
            "meeting_source": meeting_source,
            "meeting_meet_url": meeting_meet_url,
            "meeting_event_id": meeting_event_id,
            "threads": thread_rows[:8],
            "key_facts": key_facts(last_in and last_in["text"], last_out and last_out["text"]),
            "notes": (notes.get(key) or [])[:5],
            # stale = the thread moved after the Archivist last read it; renderers must
            # treat next_action as historical, never as today's action (the ininlab leak)
            "verdict": ({"summary": v.get("summary"), "next_action": v.get("next_action"),
                         "stage_signal": v_sig, "as_of": v.get("_verdict_mtime"),
                         # OUR unfulfilled promises (Archivist-extracted) — surfaced
                         # 2026-07-08 after the audit found deliverables_missing only
                         # tracks THEIR asks; bioequilabs/serbitec promise-debts were
                         # invisible on every surface.
                         "commitments_ours": (v.get("commitments_ours") or [])[:4],
                         "stale": bool((v.get("_verdict_mtime") or "") and
                                       max(li_d or "", lo_d or "")[:16] > (v.get("_verdict_mtime") or "")[:16])}
                        if v else None),
            "propose_close": propose_close,
            "close_reason": (v.get("next_action") or v.get("summary")) if propose_close else None,
            "events": events[:20],
            "frozen_meta": frozen.get(key),
            "pinged": pinged, "pinged_reason": pinged_reason,
            # V4.2 operator directives — view-layer re-sectioning only, buckets stay true.
            # A hold is active while today < until (the row RESURFACES on the date) AND
            # voids on inbound newer than the hold — "hold the nudge" never means
            # "hide their reply" (the Delta case, 2026-07-06).
            "hold_until": _hold_active(holds_reg.get(key), today, li_d),
            "hold_reason": (holds_reg.get(key) or {}).get("reason")
                           if _hold_active(holds_reg.get(key), today, li_d) else None,
            "personal": bool(personal_reg.get(key)),
            "personal_reason": (personal_reg.get(key) or {}).get("reason"),
        })

    # V4.1 Phase 4: frozen-registry entries with NO corpus presence still get a row.
    # A freeze the operator applied must be visible (and reversible) in the registry
    # view even for a company that never wrote back — previously these were counted
    # nowhere and rendered nowhere ("count only" ghosts).
    corpus_keys = {c["key"] for c in out}
    for fkey, fmeta in frozen.items():
        if fkey in corpus_keys:
            continue
        out.append({
            "key": fkey, "class": None,
            "people": [fmeta.get("email")] if fmeta.get("email") else [],
            "bucket": "cold", "state": "frozen-registry", "suppressed": "frozen",
            "them_last": False, "signals": [],
            "last_in_date": "", "last_in_from": None, "last_in_gist": None, "last_in_subj": None,
            "last_out_date": "", "last_out_gist": None,
            "touches": 0, "replies_count": 0, "bizdays_since_out": None,
            "followup_due": False, "cold_substate": None, "dead_mailbox": False, "next_due": None,
            "bounces": None, "spam_inbound": False,
            "deliverables_missing": [],
            "meeting_at": None, "meeting_state": None, "meeting_invite_sent": None,
            "meeting_source": None, "meeting_meet_url": None, "meeting_event_id": None,
            "threads": [], "key_facts": None, "notes": [],
            "verdict": None, "propose_close": False, "close_reason": None,
            "events": [], "frozen_meta": fmeta,
            "pinged": False, "pinged_reason": None,
        })

    # ---------------- board assembly
    live = [c for c in out if not c["suppressed"] and c["bucket"] != "inbound_only"]
    counts = {}
    for c in out:
        b = c["suppressed"] or c["bucket"]
        counts[b] = counts.get(b, 0) + 1
    # closed-registry entries with NO board presence still count (audit 2026-07-09:
    # apotekgroupse's only outbound was a purged draft, so the company vanished from
    # the universe entirely — snapshot said closed 1 while the registry held 2)
    _universe = {c["key"] for c in out}
    ghost_closed = sum(1 for k in closed if k not in _universe)
    if ghost_closed:
        counts["closed"] = counts.get("closed", 0) + ghost_closed
    counts["cold_due"] = sum(1 for c in live if c["cold_substate"] == "due")
    counts["cold_exhausted"] = sum(1 for c in live if c["cold_substate"] == "exhausted")
    counts["cold_not_due"] = sum(1 for c in live if c["cold_substate"] == "not_due")
    counts["cold_dead"] = sum(1 for c in live if c["cold_substate"] == "dead")
    counts["owe_review"] = sum(1 for c in live if c["bucket"] == "owe-review")
    counts["followup_due"] = sum(1 for c in live if c["followup_due"])
    counts["pinged"] = sum(1 for c in out if c.get("pinged"))

    board = {
        "meta": {
            "as_of": datetime.now(timezone.utc).isoformat(),
            "engine": "truth.py v2",
            "today": today.isoformat(),
            "corpus_age_min": corpus_age_min,
            "degraded": degraded,
            # registry-read failures this derive (present-but-unreadable files);
            # empty = healthy. The Auditor fails the board when this is non-empty.
            "load_errors": list(LOAD_ERRORS),
            "counts": counts,
            "companies_total": len(out),
            "actionable": len(live),
            "proposed_closes": [{"key": c["key"], "who": c["last_in_from"],
                                 "their_last": c["last_in_gist"], "reason": c["close_reason"],
                                 # structured fields (COCKPIT-V4 §10) — prose renders per-surface
                                 "whose_turn": "theirs" if c["them_last"] else "ours",
                                 "reason_kind": "declined" if c["state"] == "declined" else "verdict-signal",
                                 "evidence_quote": c["last_in_gist"],
                                 "last_in_date": c["last_in_date"], "last_out_date": c["last_out_date"]}
                                for c in live if c["propose_close"]],
        },
        # inbound-only rows ride the board too (operator ruling 2026-07-11: a
        # first-contact sender — someone we never emailed — must be VISIBLE for
        # review, not a count-only ghost; the 'Chinoscientist' gmail landed and
        # the console couldn't show it). They stay OUT of `live`, so actionable
        # and every cadence/cold count is unchanged; spam/probe classes remain
        # suppressed as before — junk still can't mint a visible row.
        "companies": sorted(live + [c for c in out if not c["suppressed"]
                                    and c["bucket"] == "inbound_only"],
                            key=lambda c: (
            {"owe": 0, "owe-review": 1, "awaiting": 2, "institutional": 3, "cold": 4}.get(c["bucket"], 9),
            c["last_in_date"] or ""), reverse=False),
        # frozen/closed companies — suppressed from worklists, but humans still look
        # them up (and unfreeze from) the registry view. Engaged history OR a pure
        # registry freeze both qualify; only inbound-less CLOSED stays count-only.
        "suppressed_engaged": [c for c in out
                               if c["suppressed"] in ("frozen", "closed")
                               and (c["last_in_date"] or c["suppressed"] == "frozen")],
        # operator_frozen_pinged — the tray promised by operator-frozen.json _meta,
        # rebuilt in the v2 engine (2026-07-14). A suppressed lead (frozen/closed/
        # dnc) that wrote back AFTER its suppression with a live signal. Sticky
        # freeze preserved (these are NOT in `companies`/`live`), but the reply is
        # no longer invisible: renderers surface this tray at the TOP and the
        # Auditor asserts nothing that qualifies is ever missing from it.
        "operator_frozen_pinged": sorted(
            [c for c in out if c.get("pinged")],
            key=lambda c: c.get("last_in_date") or "", reverse=True),
        "cert": None,   # certify.py v2 fills this
    }
    return board


def write_board(board):
    STATE.mkdir(parents=True, exist_ok=True)
    HISTORY.mkdir(parents=True, exist_ok=True)
    # cross-process lock: truth.py, certify.py, the console regen and the daily
    # timer can all fire at once and used to race on the SAME board.tmp inode
    # (interleaved writes -> a truncated/mixed board promoted live). A per-writer
    # unique tmp + an exclusive lock on a sidecar serialize the os.replace.
    lock = STATE / "board.lock"
    with open(lock, "w") as lf:
        try:
            import fcntl
            fcntl.flock(lf, fcntl.LOCK_EX)
        except Exception:
            pass
        tmp = BOARD.with_suffix(f".tmp.{os.getpid()}")
        tmp.write_text(json.dumps(board, ensure_ascii=False))
        os.replace(tmp, BOARD)
    snap = HISTORY / f"board-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    snap.write_text(json.dumps(board, ensure_ascii=False))
    snaps = sorted(HISTORY.glob("board-*.json"))
    for old in snaps[:-HISTORY_KEEP]:
        old.unlink()
    return BOARD


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="print the board JSON to stdout")
    ap.add_argument("--no-write", action="store_true", help="derive only, don't persist")
    args = ap.parse_args()
    board = derive()
    if not args.no_write:
        write_board(board)
        # views regenerate WITH the truth, by construction (blueprint §4) — the
        # "human layer rotted while machine truth stayed fresh" class ends here.
        try:
            import pages
            pages.main()
        except Exception as e:
            sys.stderr.write(f"# WARN page regeneration failed: {e}\n")
    if args.json:
        print(json.dumps(board, ensure_ascii=False, indent=1))
    else:
        m = board["meta"]
        print(f"board derived {m['as_of']} — {m['actionable']} actionable / {m['companies_total']} companies")
        print(json.dumps(m["counts"], indent=1))


if __name__ == "__main__":
    main()
