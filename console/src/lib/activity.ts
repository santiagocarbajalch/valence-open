"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentId } from "./agents";

// REAL activity — driven by what Valence actually does in the chat (session
// start, each tool call, the reply). Feeds both the workspace animation (orbs
// light + convene) and the shared action log. No fiction.
export type ActivityKind = "session" | "tool" | "message" | "done";
export interface ActivityEvent {
  id: number;
  ts: number;
  agent: AgentId;
  kind: ActivityKind;
  text: string;
}

let _aid = 0;
const LIVE_MS = 4500; // how long an agent stays "active" after an event

// Attribute a tool call to the agent whose realm it touches, so the RIGHT orb
// lights when Valence's work reaches into a domain. Defaults to Valence.
export function attributeAgent(name: string, input: unknown): AgentId {
  const s = (name + " " + JSON.stringify(input ?? "")).toLowerCase();
  if (/cadence|inbox|ledger|thread|archivist|\.eml|imap/.test(s)) return "archivist";
  if (/leads\/|discovery|reacher|verified|scraper|leadgen/.test(s)) return "scraper";
  if (/drafts|outbox|send-|smtp|dnc|suppression|borradores|pipeline\/sent/.test(s)) return "mailman";
  if (/clients\/|meetings\/|steward|dossier|crm/.test(s)) return "steward";
  if (/nightkeeper|systemctl|timer|registry|heartbeat/.test(s)) return "nightkeeper";
  return "valence";
}

export function useActivity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [live, setLive] = useState<Record<string, number>>({});

  const push = useCallback((agent: AgentId, kind: ActivityKind, text: string) => {
    const ts = Date.now();
    setEvents((e) => {
      const next = [...e, { id: ++_aid, ts, agent, kind, text }];
      return next.length > 80 ? next.slice(next.length - 80) : next;
    });
    setLive((l) => ({ ...l, [agent]: ts }));
  }, []);

  // expire "live" agents so their orbs settle back after they go quiet
  useEffect(() => {
    const t = setInterval(() => {
      setLive((l) => {
        const now = Date.now();
        let changed = false;
        const n: Record<string, number> = {};
        for (const k in l) {
          if (now - l[k] < LIVE_MS) n[k] = l[k];
          else changed = true;
        }
        return changed ? n : l;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  return { events, live, push };
}
