// THE sales-conditions sentence — operator-confirmed canonical form
// (vault/os/llm-shell/context/memory/reference_velab_sales_conditions.md).
// One line, no currency, no place name, no validity window; the fuller
// vault/reference/pricing/sales-terms.md is explicitly NOT for quoting.
// Every console surface that inserts or instructs sales terms goes through
// this module — nothing else may carry its own copy of the sentence.

export const SALES_TERMS: Record<"es" | "en", string> = {
  es: "Nuestras condiciones de venta son EXW, con el pago antes del embarque.",
  en: "Our sales conditions are EXW, with payment before shipment.",
};

export function termsFor(lang?: string | null): string {
  return SALES_TERMS[(lang ?? "es").toLowerCase().startsWith("en") ? "en" : "es"];
}

// Fallback when the pack entry carries no lang field: Spanish tells in the body
// decide (the house default is Spanish — most of the pipeline is LatAm).
export function detectLang(body: string): "es" | "en" {
  return /[áéíóúñ¿¡]|\b(estimad|saludo|gracias|adjunto|cotizaci)/i.test(body) ? "es"
    : /\b(dear|regards|thank you|please find)\b/i.test(body) ? "en" : "es";
}

// Insert the sentence into a draft body at the cursor, as its own paragraph.
// Returns the new body and where the cursor should land after the insert.
export function insertTerms(body: string, cursor: number, lang?: string | null): { body: string; cursor: number } {
  const line = termsFor(lang);
  const at = Math.max(0, Math.min(cursor, body.length));
  const before = body.slice(0, at);
  const after = body.slice(at);
  const pre = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const post = after.startsWith("\n\n") ? "" : after.startsWith("\n") || after.length === 0 ? "\n" : "\n\n";
  const head = before + pre + line;
  return { body: head + post + after, cursor: head.length };
}
