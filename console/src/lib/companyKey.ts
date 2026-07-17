// company key for an email — EXACT port of core/identity.py company_key()
// (the engine's single identity module; keep the two files in lockstep).
// PURE string logic, importable from client AND server (pipeline.ts re-exports it).
const TWO_LABEL = new Set(["com", "co", "org", "net", "gov", "edu", "ind", "gob", "ac", "or", "in"]);
const FREEMAIL = new Set([
  "gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "icloud.com",
  "aol.com", "live.com", "protonmail.com", "proton.me", "gmx.com", "mail.com",
  "hotmail.es", "outlook.es", "yahoo.es", "hotmail.com.mx", "live.com.mx",
  "yahoo.com.mx", "hotmail.com.br", "yahoo.com.br", "yandex.com",
]);
function registrableDomain(host: string): string {
  let h = (host ?? "").toLowerCase().trim().replace(/^>+|>+$/g, "");
  if (h.startsWith("www.")) h = h.slice(4);
  const p = h.split(".");
  if (p.length >= 3 && TWO_LABEL.has(p[p.length - 2])) return p.slice(-3).join(".");
  return p.length >= 2 ? p.slice(-2).join(".") : h;
}
export function companyKey(addr: string): string {
  const a = (addr ?? "").toLowerCase().trim().replace(/^>+|>+$/g, "");
  if (!a.includes("@")) return registrableDomain(a);
  const dom = registrableDomain(a.split("@").pop()!);
  return FREEMAIL.has(dom) ? a : dom;
}
