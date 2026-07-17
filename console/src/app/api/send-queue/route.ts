import fs from "node:fs";
import path from "node:path";
import { VAULT } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pre-flight state for the SEND stage. Surfaces every gate the operator must see
// BEFORE a send is enabled: the 50/day deliverability cap (send-ledger.json), the
// reputation kill-switch (send-pause.json), and any live grant tickets. None of
// this is mutated here — read-only dashboard.
const LEDGER = path.join(VAULT, "pipeline/send-ledger.json");
const PAUSE = path.join(VAULT, "pipeline/reputation/send-pause.json");
const APPROVALS = path.join(VAULT, "pipeline/outbox/send-approvals.json");
// Deployment sets the real outbound identity via env.
const FROM = process.env.VELAB_SEND_FROM || "rep@example.com";
const DAILY_CAP = 50;

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Grant {
  id?: string;
  recipients?: string[];
  max_sends?: number;
  used?: number;
  granted_at?: string;
  expires_at?: string;
  granted_by?: string;
  pack?: string;
  note?: string;
  revoked?: boolean;
}

export async function GET() {
  const ledger = readJson<Record<string, number>>(LEDGER, {});
  const today = utcDate();
  const sentToday = ledger[`${today}|${FROM}`] ?? 0;

  const pause = readJson<{ paused?: boolean; reason?: string; since?: string }>(PAUSE, { paused: false });

  // Exposure trim (audit 2026-07-10): the UI consumes ONLY the live-grant count
  // (prose.ts sendGuardrails); the full grant ledger — recipients, expiries,
  // packs, revoke flags — was readable on this unauthenticated Tailnet endpoint
  // for no consumer at all. The ledger stays on disk; read it there.
  const grantsRaw = readJson<Grant[]>(APPROVALS, []);
  const nowMs = Date.now();
  const liveGrants = (Array.isArray(grantsRaw) ? grantsRaw : []).filter((g) => {
    const expMs = g.expires_at ? Date.parse(g.expires_at) : 0;
    return !g.revoked && (g.used ?? 0) < (g.max_sends ?? 0) && expMs > nowMs;
  }).length;

  return Response.json({
    ranAt: nowMs,
    // whether /api/send can actually dispatch (COCKPIT_SEND_ENABLED=1 in the
    // systemd unit) — the cockpit renders SEND: LIVE / SEND: DARK from this
    sendEnabled: process.env.COCKPIT_SEND_ENABLED === "1",
    from: FROM,
    cap: DAILY_CAP,
    sentToday,
    remaining: Math.max(0, DAILY_CAP - sentToday),
    paused: !!pause.paused,
    pauseReason: pause.reason ?? null,
    liveGrants,
    spacingSeconds: 65,
  });
}
