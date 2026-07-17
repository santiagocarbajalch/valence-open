import { NextResponse, type NextRequest } from "next/server";

// Same-origin gate for every /api/* mutation. The console has no other request
// auth — it trusts its Tailnet position — so a cross-site page the operator's
// browser happens to open could otherwise forge state-changing requests (CSRF):
// a plain `fetch` with a text/plain body reaches these route handlers with no
// CORS preflight, and the write fires even though the attacker can't read the
// reply. A browser will not let page JS forge the Origin or Sec-Fetch-Site
// headers, so checking them is a complete CSRF defense that needs NO client
// change: the console's own UI is same-origin and always passes. Non-browser
// callers on the box (curl, server-side) send neither header and are left alone.
export const config = { matcher: "/api/:path*" };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sameHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  if (SAFE_METHODS.has(req.method)) return NextResponse.next();

  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");

  // Block only on positive evidence of a cross-origin caller. A same-origin UI
  // fetch carries Origin === host and Sec-Fetch-Site: same-origin; a cross-site
  // page carries a mismatched Origin or Sec-Fetch-Site: cross-site / same-site.
  const crossByOrigin = origin != null && !sameHost(origin, host);
  const crossBySite = site === "cross-site" || site === "same-site";

  if (crossByOrigin || crossBySite) {
    return NextResponse.json({ error: "cross-origin request blocked" }, { status: 403 });
  }
  return NextResponse.next();
}
