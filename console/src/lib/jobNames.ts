// Human names for background jobs — cron/unit names stay in systemd,
// the operator reads plain language (redesign brief 2, directive 6).

const JOB_NAMES: Record<string, string> = {
  "velab-backup": "Vault backup",
  "velab-vault-push": "Push server backup to GitHub",
  "archivist-sweep": "Archivist sweep",
  "archivist-read": "Archivist daily read",
  "archivist-watch": "Archivist watch",
  "corpus-reconcile": "Rebuild company records",
  "corpus-backfill": "Backfill mail corpus",
  "corpus-warm": "Warm the mail cache",
  "velab-care-poll": "Customer-care inbox poll",
  "velab-hubspot-sync": "HubSpot sync",
  "velab-hubspot-pull": "HubSpot nightly pull",
  "velab-leadstate": "Refresh lead states",
  "crm-sync": "CRM dossier sync",
  "velab-integrity-context": "Integrity audit",
  "velab-security-context": "Security audit",
  "velab-security": "Security checks",
  "velab-heartbeat": "Timer heartbeat",
  "claude-remote": "Remote-control link",
  "valence-console": "This console",
};

export function humanJobName(base: string): string {
  if (JOB_NAMES[base]) return JOB_NAMES[base];
  const t = base.replace(/^velab-/, "").replace(/-/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// "vault backup 2026-07-02T03:18:16Z [session]" → "Backed up (auto, during a chat session)"
export function humanCommitMsg(msg: string): string {
  const m = msg.match(/backup .*\[(session|timer|manual)\]/i);
  if (m) {
    const how = m[1] === "session" ? "auto, during a chat session" : m[1] === "timer" ? "scheduled" : "manual";
    return `Backed up (${how})`;
  }
  return msg;
}

// "velab-backup-20260702-000001.tar.gz" → "Backup"
export function humanSnapshotName(name: string): string {
  return /^velab-backup-/.test(name) ? "Backup" : name.replace(/\.tar\.gz$/, "");
}
