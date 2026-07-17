import fs from "node:fs";
import path from "node:path";
import { WORKSPACE } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The attachment library. Paths are returned RELATIVE to WORKSPACE because that's
// exactly what a draft pack's `attachments[]` expects (resolved against workspace by
// stage_drafts_in_gmail.js / send_batch.py). smtp.js's validateReadPath restricts
// attachable files to ALLOWED_READ_DIRS, so we only surface the assets/email tree.
const ASSETS = path.join(WORKSPACE, "assets/email");

function kindOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".pdf") return name.startsWith("VE-") || name.toLowerCase().includes("ficha") ? "ficha" : "catalog";
  if (ext === ".xlsx" || ext === ".xls") return "pricelist";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  return "file";
}

function walk(dir: string, relBase: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.join(relBase, e.name);
    if (e.isDirectory()) {
      out.push(...walk(abs, rel));
    } else if (e.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        /* ignore */
      }
      out.push({
        name: e.name,
        // relative to WORKSPACE — what `attachments[]` wants
        path: path.relative(WORKSPACE, abs),
        group: path.relative(ASSETS, dir) || ".",
        kind: kindOf(e.name),
        size,
      });
    }
  }
  return out;
}

export async function GET() {
  const files = walk(ASSETS, path.relative(WORKSPACE, ASSETS));
  files.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.name).localeCompare(String(b.name)));
  return Response.json({ root: path.relative(WORKSPACE, ASSETS), defaultAttach: "assets/email/petri-dishes-promo.png", files });
}
