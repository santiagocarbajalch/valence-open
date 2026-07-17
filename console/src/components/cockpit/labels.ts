// Human language for pack names, template codes and statuses.
// Internal IDs stay in the files; the operator never reads them.
// A11y rebuild 2026-07-03: sentence case — uppercase runs read measurably
// slower and are worse for dyslexic readers.

const TEMPLATE_LABEL: Record<string, string> = {
  "COLD-01-INITIAL": "First cold touch",
  "COLD-02-FOLLOWUP": "Second cold touch",
  "COLD-03-FINAL": "Final cold touch",
  "COLD-03-BREAKUP": "Final cold touch",
  "REPLY": "Reply",
  "REPLY-MEETING-CONFIRM": "Confirming a meeting",
  "REPLY-REENGAGE": "Re-engaging",
  "REPLY-TECH-INFO": "Tech info",
  "REPLY-ASK-CONTACT": "Asking for a contact",
  "REPLY-PRICING": "Pricing",
  "FOLLOWUP": "Follow-up",
};

// Diacritics the file-safe internal codes drop (mixed-language chrome audit
// item: "licitacion" un-accented in a UI tag reads as sloppy, not bilingual).
const ACCENT_FIX: Record<string, string> = { licitacion: "licitación", cotizacion: "cotización" };

const sentence = (s: string) => {
  const t = s.toLowerCase().replace(/-/g, " ").trim()
    .split(" ").map((w) => ACCENT_FIX[w] ?? w).join(" ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function humanType(code?: string | null): string {
  if (!code) return "";
  const c = code.toUpperCase().trim();
  if (TEMPLATE_LABEL[c]) return TEMPLATE_LABEL[c];
  if (c.startsWith("COLD-")) return "Cold touch";
  if (c.startsWith("REPLY-")) return sentence(c.replace(/^REPLY-/, ""));
  return sentence(c);
}

export function humanTypes(codes: (string | undefined | null)[]): string {
  return Array.from(new Set(codes.map(humanType).filter(Boolean))).join(" · ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function humanDate(iso?: string | null): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${parseInt(m[3], 10)} ${MONTHS[parseInt(m[2], 10) - 1]}`;
}

// "cadence-followups-2026-07-01-cold-EN" → "Cadence follow-ups · cold · English"
const WORD_FIX: Record<string, string> = { EN: "English", ES: "Spanish", PT: "Portuguese", followups: "follow-ups" };
export function humanPackTitle(rawLabel: string, date?: string | null): string {
  let base = rawLabel.replace(/\.threaded$/, "").replace(/\.json$/, "");
  // an already-human batch_label (has spaces, no filename tells) passes through
  if (/\s/.test(base) && !base.includes("__") && !/\d{4}-\d{2}-\d{2}/.test(base)) {
    return date ? `${base} · ${humanDate(date)}` : base;
  }
  base = base.replace(/\d{4}-\d{2}-\d{2}/g, "");
  const words = base.split(/[_\-·]+/).filter(Boolean)
    .map((w) => WORD_FIX[w] ?? WORD_FIX[w.toLowerCase()] ?? w.toLowerCase());
  const joined = words.join(" ").replace(/\s+/g, " ").trim();
  const title = joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : rawLabel;
  return date ? `${title} · ${humanDate(date)}` : title;
}
