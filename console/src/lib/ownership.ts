// Which agent OWNS which live systemd unit. The VenusV2 HEARTBEAT.md tables
// declare each agent's intended units (mostly not yet shipped); this maps the
// units that are ACTUALLY running on the box to their owning agent. Keyed by
// bare unit base-name (no .timer/.service suffix). Operator-editable — keep honest.
export const LIVE_OWNERSHIP: Record<string, string[]> = {
  // corpus-reconcile (4x/day timer) + corpus-today (on-receipt service, kicked by archivist-watch)
  // are the sharded inbox-corpus pull pipeline that feeds /inbox-check. They replaced the old
  // corpus-warm 10-min open-scan (disabled 2026-06-29 — it throttled Gmail and clobbered the cache).
  archivist: ["archivist-read", "archivist-sweep", "archivist-watch", "corpus-reconcile", "corpus-today"],
  // velab-valence-push retired 2026-07-06 — console source now rides velab-vault-push
  // into the ONE unified repo (the private backup repo).
  nightkeeper: ["velab-backup", "velab-vault-push"],
  steward: ["velab-hubspot", "velab-hubspot-pull", "velab-care-poll"],
  valence: ["valence-console", "valence-pty", "venus-design-lab"],
};

// reverse lookup: unit base-name → owning agent id (or null if unassigned/system)
export function ownerOf(base: string): string | null {
  for (const [agent, units] of Object.entries(LIVE_OWNERSHIP)) {
    if (units.includes(base)) return agent;
  }
  return null;
}
