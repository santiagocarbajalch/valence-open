#!/usr/bin/env bash
#
# velab_backup.sh — deterministic backup of Velab OS critical state.
# Runs 4x/day via velab-backup.timer. NO LLM / Claude involvement.
#
# Why this exists: on 2026-06-20 `rm -rf ~/.claude/` wiped harness memory + all
# skills. The vault-sync that would have let us restore had been decommissioned
# 2026-06-15, so the only copy was a frozen 06-14 mirror. This restores a
# guarded, scheduled backup so that never costs us recoverable state again.
#
# Two jobs each run:
#   A. MIRROR live-but-not-in-vault state INTO the vault  -> vault/os/mirror/
#      (so the vault is the source of truth and a wipe of ~/.claude is fully
#       recoverable from the vault).
#   B. SNAPSHOT the whole critical set as a timestamped, rotated tar.gz under
#      ${VELAB_SNAP_DIR:-/opt/velab/backups/snapshots}/.
#
# SAFETY GUARD (the thing the old sync lacked): if a source dir looks wiped
# (below a sane floor), the MIRROR step is SKIPPED, so a deletion is never
# propagated into the vault (rsync --delete would otherwise erase the good
# mirror too). Snapshots always include the vault, which still holds the last
# good mirror, so even a post-wipe run preserves recoverable state.

set -uo pipefail

TS="$(date -u +%Y%m%d-%H%M%S)"
MIRROR=${VELAB_VAULT:-/opt/velab/vault}/os/mirror
SNAP_DIR=${VELAB_SNAP_DIR:-/opt/velab/backups/snapshots}
LOG=${VELAB_VAULT:-/opt/velab/vault}/os/schedule/logs/velab-backup.log
KEEP=16            # 16 snapshots = 4 days at 4x/day
SKILLS_FLOOR=5     # fewer skill dirs than this => treat as wiped, skip mirror
MEMORY_FLOOR=10    # fewer memory files than this => treat as wiped, skip mirror

mkdir -p "$MIRROR" "$SNAP_DIR" "$(dirname "$LOG")"
log(){ echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

log "backup START ($TS)"

# ---------- Part A: mirror live -> vault (guarded) ----------
# Count dirs AND symlinks: most skills are symlinks into ~/.agents/skills, so a
# -type d count would always read low and falsely trip the wipe-guard.
skills_n=$(find ${HOME}/.claude/skills -maxdepth 1 -mindepth 1 \( -type d -o -type l \) 2>/dev/null | wc -l)
# Memory + commands are VAULT-CANONICAL since 2026-07-12 (vault/os/llm-shell/;
# ~/.claude paths are symlinks into it), so they need no mirror step — the vault
# body already carries them. The floor check now guards the canonical dir.
mem_n=$(find ${VELAB_VAULT:-/opt/velab/vault}/os/llm-shell/context/memory -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l)

if [ "$skills_n" -ge "$SKILLS_FLOOR" ] && [ "$mem_n" -ge "$MEMORY_FLOOR" ]; then
  rsync -a --delete ${HOME}/.claude/skills/                "$MIRROR/claude-skills/"
  # ~/.agents/skills holds the REAL content of the symlinked skills above; the
  # claude-skills mirror only stores the symlinks, so this is what makes them
  # actually recoverable.
  rsync -a --delete ${HOME}/.agents/skills/                "$MIRROR/agents-skills/"
  mkdir -p "$MIRROR/claude-settings"
  rsync -a ${HOME}/.claude/settings.json ${HOME}/.claude/settings.local.json "$MIRROR/claude-settings/" 2>/dev/null
  rsync -a --delete ${VELAB_HOME:-/opt/velab}/workspace/tools/     "$MIRROR/workspace-tools/"
  mkdir -p "$MIRROR/systemd"
  shopt -s nullglob
  cp -a /etc/systemd/system/velab-* \
        /etc/systemd/system/claude-remote.service "$MIRROR/systemd/" 2>/dev/null
  shopt -u nullglob
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MIRROR/.last-sync"
  log "mirror OK  (skills=$skills_n memory=$mem_n)"
else
  log "mirror SKIPPED — source looks wiped (skills=$skills_n<$SKILLS_FLOOR or memory=$mem_n<$MEMORY_FLOOR); vault mirror left intact"
fi

# ---------- Part A2: regenerate vault indexes (added 2026-07-12) ----------
# vault_index.py + leadbook.py were retired to _archive/ in June and the whole
# index layer froze for 29 days. Restored + run here so every snapshot (and the
# off-server push in Part C) carries fresh indexes. Deterministic, no LLM.
python3 ${VELAB_HOME:-/opt/velab}/workspace/tools/vault_index.py >/dev/null 2>>"$LOG" \
  && python3 ${VELAB_HOME:-/opt/velab}/workspace/tools/leadbook.py >/dev/null 2>>"$LOG" \
  && log "indexes regenerated (vault_index + leadbook)" \
  || log "index regeneration FAILED (see stderr above) — continuing with snapshot"

# path-assert: documentation-rot detector (added 2026-07-12) — asserts every
# an absolute path cited in high-trust docs still exists; report to
# vault/audits/path-assert/latest.md. Detector only, never blocks the backup.
python3 ${VELAB_HOME:-/opt/velab}/workspace/tools/path_assert.py >/dev/null 2>>"$LOG" \
  && log "path-assert report refreshed" \
  || log "path-assert FAILED (non-blocking)"

# ---------- Part B: timestamped snapshot ----------
# Snapshot targets, relative to the `-C /` below. This LOCAL snapshot deliberately
# includes the deployment's credential files — it is the ONLY place secrets are
# captured, and it is chmod 600 + never leaves the box. The off-server push
# (velab_vault_push.sh) EXCLUDES every credential path by construction. The paths
# below are generic placeholders — replace them with your deployment's real home
# and credential locations. HOME_REL / APP_REL are relative to `/`.
HOME_REL="${VELAB_HOME_REL:-home/velab}"       # e.g. the service account's home
APP_REL="${VELAB_APP_REL:-opt/velab}"          # e.g. the application install root
CANDIDATES=(
  # recoverable system (no secrets):
  "$HOME_REL/.agent/skills"
  "$HOME_REL/.agent/commands"
  "$HOME_REL/.agent/memory"
  "$HOME_REL/.agent/settings.json"
  "$APP_REL/core"
  "$APP_REL/vault"
  "$APP_REL/workspace/tools"
  "$APP_REL/workspace/skills"
  "$APP_REL/valence-console"
  "$APP_REL/VenusV2"
  # credential files — captured in the LOCAL snapshot only, never pushed off-server:
  "$APP_REL/secrets"
  "$HOME_REL/.example-service.env"    # e.g. a CRM/webhook token file
  "$HOME_REL/.config/mail-agent"      # e.g. IMAP/SMTP credentials
  "$HOME_REL/.config/cli-credentials" # e.g. a provider CLI credential store
  "$HOME_REL/.config/git-hosts.yml"   # e.g. git host tokens
  "$HOME_REL/.credentials"            # e.g. the model provider credential store
)
PATHS=()
for p in "${CANDIDATES[@]}"; do [ -e "/$p" ] && PATHS+=("$p"); done

SNAP="$SNAP_DIR/velab-backup-$TS.tar.gz"
tar -czf "$SNAP" --warning=no-file-changed \
    --exclude='*/node_modules' --exclude='*/.cache' --exclude='*/.next' \
    -C / "${PATHS[@]}" 2>>"$LOG"
rc=$?
if [ -s "$SNAP" ]; then
  chmod 600 "$SNAP"
  log "snapshot OK (tar rc=$rc)  $(du -h "$SNAP" | cut -f1)  -> $SNAP"
else
  log "snapshot FAILED rc=$rc"
fi

# ---------- rotation ----------
mapfile -t old < <(ls -1t "$SNAP_DIR"/velab-backup-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)))
if [ "${#old[@]}" -gt 0 ]; then rm -f "${old[@]}"; log "rotated: removed ${#old[@]} old snapshot(s), keeping newest $KEEP"; fi

# ---------- Part C: off-server push to private GitHub (durability beyond the VPS) ----------
if [ -x ${VELAB_HOME:-/opt/velab}/workspace/tools/velab_vault_push.sh ]; then
  ${VELAB_HOME:-/opt/velab}/workspace/tools/velab_vault_push.sh timer || log "vault-push returned nonzero (see velab-vault-push.log)"
fi

log "backup DONE ($TS)"
