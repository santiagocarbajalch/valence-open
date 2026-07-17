import { jobStatus, validJobId } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/job?id=<jobId> — poll a detached job's status + output tails.
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!validJobId(id)) return Response.json({ error: "bad id" }, { status: 400 });
  const st = jobStatus(id);
  if (!st) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(st);
}
