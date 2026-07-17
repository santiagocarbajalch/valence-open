// Reader for THE canonical agent→realm map: vault/os/ownership.md.
// That file is OPERATOR-OWNED (tools read, never write). Ownership FACTS come
// from here; console lib/agents.ts contributes only visual identity (colors).
// Parsed from the manifest's markdown table:
//   | **Agent** | `path/` · `path/` … | `agents/<id>/` |
// plus the *(unassigned pending operator)* row. Cached by file mtime.
import fs from "node:fs";
import path from "node:path";
import { VAULT } from "./vault";

export const OWNERSHIP_FILE = path.join(VAULT, "os/ownership.md");

export interface OwnershipEntry {
  agent: string; // display name, e.g. "Archivist"
  paths: string[]; // vault-relative dirs it owns today, no trailing slash
  target: string | null; // approved physical-reorg destination (informational)
}
export interface Ownership {
  agents: OwnershipEntry[];
  unassigned: string[];
  asOf: number; // manifest mtime (0 = manifest missing)
}

let cache: { mtime: number; data: Ownership } | null = null;

export function loadOwnership(): Ownership {
  let mtime = 0;
  try { mtime = fs.statSync(OWNERSHIP_FILE).mtimeMs; } catch { /* absent → empty map */ }
  if (cache && cache.mtime === mtime) return cache.data;

  const agents: OwnershipEntry[] = [];
  const unassigned: string[] = [];
  let text = "";
  try { text = fs.readFileSync(OWNERSHIP_FILE, "utf8"); } catch { /* absent */ }

  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (cells[0] === "Agent" || /^[:\s-]+$/.test(cells[0])) continue; // header / separator
    const paths = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/^\/+|\/+$/g, ""));
    const bold = cells[0].match(/\*\*(.+?)\*\*/);
    if (bold) {
      const target = cells[2]?.match(/`([^`]+)`/)?.[1]?.replace(/\/+$/, "") ?? null;
      agents.push({ agent: bold[1], paths, target });
    } else if (/unassigned/i.test(cells[0])) {
      unassigned.push(...paths);
    }
  }

  const data: Ownership = { agents, unassigned, asOf: mtime };
  cache = { mtime, data };
  return data;
}

/** Vault-relative path → owning agent's display name (longest-prefix match), or null. */
export function vaultOwnerOf(rel: string): string | null {
  const clean = rel.replace(/^\/+|\/+$/g, "");
  let best: string | null = null;
  let bestLen = -1;
  for (const a of loadOwnership().agents) {
    for (const p of a.paths) {
      if ((clean === p || clean.startsWith(p + "/")) && p.length > bestLen) {
        best = a.agent;
        bestLen = p.length;
      }
    }
  }
  return best;
}
