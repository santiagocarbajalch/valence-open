// Human language for the lead-mining vocabulary: discovery category keys,
// legacy batch client_type values, and geo slugs. Internal keys stay in the
// files; the operator never reads them. This is the ONE module both the
// scraping routes (canonicalization) and the scraping view (display) resolve
// through — no surface renders a raw slug.

// Operator geo doctrine: broad allowlist, ONLY Mexico + India excluded — the
// run route enforces the ban server-side; this list seeds the picker and is
// the canonical spelling veins must resolve to before they may prefill it.
export const COUNTRIES = [
  "Colombia", "Ecuador", "Peru", "Argentina", "Chile", "Guatemala", "Costa Rica",
  "Panama", "Bolivia", "Paraguay", "Uruguay", "Dominican Republic", "El Salvador",
  "Honduras", "Nicaragua", "Brazil", "United States", "Vietnam", "Thailand",
  "Philippines", "Indonesia", "Malaysia", "South Africa", "Kenya", "Nigeria",
  "Ghana", "UAE", "Saudi Arabia", "Egypt", "Morocco", "Jordan",
];

// Legacy batch client_type → live discovery category key. ONLY certain
// matches belong here — an uncertain guess would prefill the wrong dig.
const CATEGORY_CANON: Record<string, string> = {
  "lab-distributor": "lab-equipment-distributor",
  "school-district": "k12-public-school-district",
};

// Display names for batch types the discovery tool no longer lists (or that
// predate it). Anything not named here falls back to sentence-cased words.
const CATEGORY_WORD: Record<string, string> = {
  "lab-distributor": "Lab equipment distributors",
  "lab-equipment-distributor": "Lab equipment distributors",
  "university-procurement": "University purchasing offices",
  "school-district": "School districts",
  "k12-public-school-district": "School districts",
  "hubspot-legacy": "HubSpot import",
};

const GEO_WORD: Record<string, string> = {
  "us-latam": "US + Latin America",
  latam: "Latin America",
  "texas-us": "Texas (US)",
  "ohio-us": "Ohio (US)",
  andes: "Andes region",
  "south-america": "South America",
  "unknown-geo": "region not recorded",
  uae: "UAE",
  usa: "United States",
  us: "United States",
};

// Geos that aren't a picker country verbatim but honestly resolve to one.
const GEO_CANON: Record<string, string> = {
  "texas-us": "United States",
  "ohio-us": "United States",
  usa: "United States",
  us: "United States",
};

const titleCase = (slug: string) =>
  slug.split(/[-_]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

const sentenceCase = (slug: string) => {
  const t = slug.replace(/[-_]+/g, " ").trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Batch type in the operator's words; honest about missing data. */
export function categoryWord(raw?: string | null): string {
  if (!raw || raw === "—") return "type not recorded";
  return CATEGORY_WORD[raw.toLowerCase()] ?? sentenceCase(raw);
}

/** Geo in the operator's words; honest about missing data. */
export function geoWord(raw?: string | null): string {
  if (!raw || raw === "—") return "region not recorded";
  return GEO_WORD[raw.toLowerCase()] ?? titleCase(raw);
}

/** One batch, one plain title: "Lab equipment distributors — Ecuador". */
export function batchTitle(category?: string | null, geo?: string | null): string {
  return `${categoryWord(category)} — ${geoWord(geo)}`;
}

/** Resolve a stored batch type to a live picker key, or null if it can't be
 *  resolved with certainty (an unresolvable vein must not render a control). */
export function canonicalCategory(raw: string, liveKeys: string[]): string | null {
  const k = CATEGORY_CANON[raw.toLowerCase()] ?? raw.toLowerCase();
  return liveKeys.includes(k) ? k : null;
}

/** Resolve a stored geo to the picker's canonical country spelling, or null. */
export function canonicalCountry(raw: string): string | null {
  const low = raw.toLowerCase();
  const mapped = GEO_CANON[low];
  if (mapped) return mapped;
  const asWords = low.replace(/[-_]+/g, " ");
  return COUNTRIES.find((c) => c.toLowerCase() === asWords) ?? null;
}
