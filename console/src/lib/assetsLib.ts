// Server-only helpers over the attachment asset library (workspace/assets/email)
// — the same tree /api/assets surfaces and stage/send resolve attachments[]
// against. Two jobs:
//   validateAssetPaths — refuse anything outside the library or missing on disk
//     (server-side guard, doctrine tenet 23; a bad path would otherwise kill
//     the send at stage time).
//   suggestAttachments — deterministic keyword scan of what the client asked
//     for (their last message + the engine's deliverables list) → catalog /
//     price-list assets, language-matched. Suggestions ride into the draft the
//     agent writes; the draft card's attachment chips show them for review —
//     nothing sends unseen.
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE } from "@/lib/vault";

const ASSETS = path.join(WORKSPACE, "assets/email");

export function validateAssetPaths(paths: string[]): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  const root = path.resolve(ASSETS);
  for (const rel of paths) {
    const clean = (rel ?? "").trim();
    if (!clean) continue;
    const abs = path.resolve(WORKSPACE, clean);
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) bad.push(clean);
    else ok.push(clean);
  }
  return { ok, bad };
}

// Root-level library files by kind (same kind rules as /api/assets).
function libraryRoot(): { name: string; rel: string; kind: "catalog" | "pricelist" | "other" }[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(ASSETS, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isFile()).map((e) => {
    const ext = path.extname(e.name).toLowerCase();
    const kind = ext === ".pdf" && !e.name.startsWith("VE-") && !e.name.toLowerCase().includes("ficha") ? "catalog"
      : ext === ".xlsx" || ext === ".xls" ? "pricelist" : "other";
    return { name: e.name, rel: path.relative(WORKSPACE, path.join(ASSETS, e.name)), kind: kind as "catalog" | "pricelist" | "other" };
  });
}

const SPANISH_TELLS = /[áéíóúñ¿¡]|\b(precios?|cat[aá]logo|cotizaci[oó]n|lista de precios|gracias|saludos|estimad)/i;
const ASKS_CATALOG = /\bcat[aá]log(o|ue|s)?\b|\bbrochure\b|\bportafolio\b|\bportfolio\b|product (line|range|list)/i;
const ASKS_PRICES = /price\s?-?list|lista de precios|\bprecios\b|\bpricing\b|\btarifas?\b|\bcotizaci[oó]n\b|\bquote\b|\bquotation\b/i;

// text = whatever we know they asked (last inbound gist + deliverables strings)
export function suggestAttachments(text: string): { paths: string[]; labels: string[] } {
  if (!text.trim()) return { paths: [], labels: [] };
  const lib = libraryRoot();
  const spanish = SPANISH_TELLS.test(text);
  const paths: string[] = [];
  const labels: string[] = [];
  if (ASKS_CATALOG.test(text)) {
    const catalogs = lib.filter((f) => f.kind === "catalog");
    const wanted = catalogs.find((f) => /eng/i.test(f.name) === !spanish) ?? catalogs[0];
    if (wanted) { paths.push(wanted.rel); labels.push(spanish ? "catálogo (PDF)" : "catalog (PDF)"); }
  }
  if (ASKS_PRICES.test(text)) {
    const pl = lib.find((f) => f.kind === "pricelist");
    if (pl) { paths.push(pl.rel); labels.push(spanish ? "lista de precios (Excel)" : "price list (Excel)"); }
  }
  return { paths, labels };
}
