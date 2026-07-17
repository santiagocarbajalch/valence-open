import fs from "node:fs";
import path from "node:path";
import { VAULT, safeUnder } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Path-guarded read/write of a draft pack. Mirrors /api/agent/file: resolve under
// the drafts dir only, reject traversal, cap size, must pre-exist on write. The
// operator edits subject/body/attachments/lang here before staging.
const DRAFTS_DIR = path.join(VAULT, "pipeline/drafts");
const MAX = 2 * 1024 * 1024;

export async function GET(req: Request) {
  const file = new URL(req.url).searchParams.get("file") ?? "";
  const abs = safeUnder(DRAFTS_DIR, file);
  if (!abs) return Response.json({ error: "bad path" }, { status: 403 });
  try {
    return Response.json({ file, content: fs.readFileSync(abs, "utf8"), mtime: fs.statSync(abs).mtimeMs });
  } catch {
    return Response.json({ error: "not found" }, { status: 404 });
  }
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { file?: string; content?: string };
  const abs = safeUnder(DRAFTS_DIR, body.file ?? "");
  if (!abs) return Response.json({ error: "bad path" }, { status: 403 });
  if (typeof body.content !== "string") return Response.json({ error: "no content" }, { status: 400 });
  if (Buffer.byteLength(body.content) > MAX) return Response.json({ error: "too large" }, { status: 413 });
  if (!fs.existsSync(abs)) return Response.json({ error: "must pre-exist" }, { status: 404 });
  // validate JSON before clobbering a pack
  try {
    JSON.parse(body.content);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  fs.writeFileSync(abs, body.content);
  return Response.json({ ok: true, mtime: fs.statSync(abs).mtimeMs });
}
