import fs from "node:fs";
import path from "node:path";
import { VAULT, TOOLS, PY, run } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read/write the single source of truth for the VELAB outbound house format
// (vault/pipeline/house-format.json). Both the Python sender (send_batch.house_html)
// and the JS stager (stage_drafts_in_gmail.houseHtml) read this file, falling back to
// their embedded (identical) defaults if it's missing. The preview is rendered by the
// REAL house_html() via house_format_preview.py, so what the operator sees is exactly
// what a customer receives.
const HOUSE_FORMAT = path.join(VAULT, "pipeline/house-format.json");
const PREVIEW = path.join(TOOLS, "house_format_preview.py");

interface SigLine { text: string; style: string }
interface HouseFormat {
  _note?: string;
  body: { div_style: string; paragraph_style: string };
  signature: { strip_lines: string[]; lines: SigLine[] };
  defaults: { cc: string; attach: string };
}

async function preview(): Promise<string> {
  const r = await run(PY, [PREVIEW], { cwd: TOOLS, timeout: 20_000 });
  return r.code === 0 ? r.stdout : "";
}

export async function GET() {
  let config: unknown = null;
  let exists = false;
  try {
    config = JSON.parse(fs.readFileSync(HOUSE_FORMAT, "utf8"));
    exists = true;
  } catch {
    config = null;
  }
  return Response.json({ ok: true, exists, path: "vault/pipeline/house-format.json", config, previewHtml: await preview() });
}

// Validate the shape so a bad PUT can never write a config the tools choke on.
function validate(c: unknown): c is HouseFormat {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  const body = o.body as Record<string, unknown> | undefined;
  const sig = o.signature as Record<string, unknown> | undefined;
  const def = o.defaults as Record<string, unknown> | undefined;
  if (!body || typeof body.div_style !== "string" || typeof body.paragraph_style !== "string") return false;
  if (!sig || !Array.isArray(sig.strip_lines) || !Array.isArray(sig.lines)) return false;
  if (!sig.strip_lines.every((s) => typeof s === "string")) return false;
  if (!sig.lines.every((l) => l && typeof (l as SigLine).text === "string" && typeof (l as SigLine).style === "string")) return false;
  if (!def || typeof def.cc !== "string" || typeof def.attach !== "string") return false;
  return true;
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { config?: unknown };
  const c = body.config;
  if (!validate(c)) {
    return Response.json({ ok: false, error: "invalid house-format shape (need body{div_style,paragraph_style}, signature{strip_lines[],lines[{text,style}]}, defaults{cc,attach})" }, { status: 400 });
  }
  // preserve/refresh the human note; write pretty so it stays hand-editable.
  const toWrite: HouseFormat = {
    _note: (c as HouseFormat)._note ?? "Single source of truth for VELAB outbound house format. Edited via the Valence cockpit; read by send_batch.py + stage_drafts_in_gmail.js. Both fall back to embedded defaults if this file is absent.",
    body: c.body,
    signature: c.signature,
    defaults: c.defaults,
  };
  try {
    fs.writeFileSync(HOUSE_FORMAT, JSON.stringify(toWrite, null, 2) + "\n");
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
  return Response.json({ ok: true, saved: true, previewHtml: await preview() });
}
