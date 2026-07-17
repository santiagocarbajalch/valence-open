import fs from "node:fs";
import path from "node:path";
import { VAULT } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VERIFIED_DIR = path.join(VAULT, "leads/verified");
const LEDGER = path.join(VAULT, "pipeline/cadence/ledger.json");

// Already-contacted = any email tracked in the cadence ledger. The fresh-outreach
// picker must subtract these so we never cold-open someone already in a sequence.
function contactedSet(): Set<string> {
  const s = new Set<string>();
  try {
    const led = JSON.parse(fs.readFileSync(LEDGER, "utf8")) as { leads?: { email?: string }[] };
    for (const l of led.leads ?? []) if (l.email) s.add(l.email.toLowerCase());
  } catch {
    /* ledger optional */
  }
  return s;
}

interface VLead {
  institution?: string;
  email?: string;
  phone?: string;
  country?: string;
  contact_name?: string;
  title?: string;
  verification?: { is_reachable?: string };
}
interface VBatch {
  batch_id?: string;
  client_type?: string;
  geo?: string;
  date?: string;
  leads?: VLead[];
}

// GET /api/leads?geo=&type=&limit= → verified inventory minus already-contacted.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const geoF = (url.searchParams.get("geo") ?? "").toLowerCase();
  const typeF = (url.searchParams.get("type") ?? "").toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);

  const contacted = contactedSet();
  let names: string[] = [];
  try {
    names = fs.readdirSync(VERIFIED_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return Response.json({ leads: [], facets: { geos: [], types: [] }, total: 0, contactedHidden: 0 });
  }

  const out: Record<string, unknown>[] = [];
  const geos = new Set<string>();
  const types = new Set<string>();
  const seen = new Set<string>();
  let contactedHidden = 0;

  for (const name of names) {
    let b: VBatch;
    try {
      b = JSON.parse(fs.readFileSync(path.join(VERIFIED_DIR, name), "utf8")) as VBatch;
    } catch {
      continue;
    }
    if (b.geo) geos.add(b.geo);
    if (b.client_type) types.add(b.client_type);
    for (const l of b.leads ?? []) {
      const email = (l.email ?? "").toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      if (contacted.has(email)) {
        contactedHidden++;
        continue;
      }
      if (geoF && (b.geo ?? "").toLowerCase() !== geoF) continue;
      if (typeF && (b.client_type ?? "").toLowerCase() !== typeF) continue;
      out.push({
        institution: l.institution ?? "",
        email: l.email,
        contactName: l.contact_name ?? "",
        title: l.title ?? "",
        phone: l.phone ?? "",
        country: l.country ?? "",
        geo: b.geo ?? "",
        clientType: b.client_type ?? "",
        batch: b.batch_id ?? name,
        reachable: l.verification?.is_reachable ?? null,
      });
    }
  }

  return Response.json({
    total: out.length,
    contactedHidden,
    facets: { geos: [...geos].sort(), types: [...types].sort() },
    leads: out.slice(0, limit),
  });
}
