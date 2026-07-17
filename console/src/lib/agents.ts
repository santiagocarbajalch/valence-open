// The VenusOS V2 roster — the six BUILT nodes. Colors are each node's identity
// color from the master plan (tuned slightly for luminance on the dark field).
// Valence is central command; the rest are workers. This data drives the tiles
// and the orbs; when the console wires to real state, only the runtime layer
// changes — this identity layer stays.

export type AgentId =
  | "valence"
  | "archivist"
  | "nightkeeper"
  | "scraper"
  | "mailman"
  | "steward";

export interface Agent {
  id: AgentId;
  name: string;
  role: string;
  realm: string;
  color: string; // identity color (CSS hex)
  central?: boolean;
}

export const AGENTS: Agent[] = [
  {
    id: "valence",
    name: "Valence",
    role: "central command",
    realm: "os",
    color: "#d9b13a",
    central: true,
  },
  {
    id: "archivist",
    name: "Archivist",
    role: "source of truth",
    realm: "inbox",
    color: "#4d8bd1",
  },
  {
    id: "nightkeeper",
    name: "Nightkeeper",
    role: "job reconciler",
    realm: "nightkeeper",
    color: "#8c7cf0",
  },
  {
    id: "scraper",
    name: "Scraper",
    role: "lead sourcing",
    realm: "leads",
    color: "#cf8a52",
  },
  {
    id: "mailman",
    name: "Mailman",
    role: "outbound mail",
    realm: "pipeline",
    color: "#d4587a",
  },
  {
    id: "steward",
    name: "Steward",
    role: "audits + reference",
    realm: "reference",
    color: "#4fa888",
  },
];

export const AGENT_BY_ID: Record<AgentId, Agent> = Object.fromEntries(
  AGENTS.map((a) => [a.id, a]),
) as Record<AgentId, Agent>;

// Visual identity for agents that appear in the vault OWNERSHIP MANIFEST
// (vault/os/ownership.md — the canonical agent→realm map) but aren't in the
// six-orb roster above. Ownership FACTS come from the manifest; this record is
// presentation only (colors/roles), same contract as AGENTS.
export const EXTRA_IDENTITY: Record<string, { color: string; role: string }> = {
  bids: { color: "#56b8d8", role: "public procurement" },
};

// neutral fallback for a manifest agent with no declared identity color
export const DEFAULT_AGENT_COLOR = "#8d98ab";
