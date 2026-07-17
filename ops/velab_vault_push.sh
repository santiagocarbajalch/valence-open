#!/usr/bin/env bash
#
# velab_vault_push.sh — OFF-SERVER durability. Mirror the vault (incl. the claude
# memory/skills/commands/settings mirrors under os/mirror/), the core engine, and the
# valence console source to the ONE PRIVATE GitHub repo (the private backup repo) so the recoverable
# system survives loss of the whole VPS. Unified 2026-07-06: the private backup repo is the single repo;
# velab-valence-console and velabia were merged in / retired.
#
# Triggered: 4x/day by velab_backup.sh (Part C), and on Claude session open/close
# via velab-vault-push.service. NO LLM involvement.
#
# SECURITY: NEVER pushes credentials.
#   - claude-remote.service is excluded as defense-in-depth (no longer holds a token as of
#     2026-06-30 — auth moved to on-disk the provider CLI credential store — but kept excluded
#     so a future re-added secret can't leak off-server).
#   - the vault body is secret-free by doctrine ("secrets never vaulted/mirrored").
#   - a value-based secret SCAN runs on the staging tree before every commit and
#     ABORTS the push if anything credential-shaped is found.

set -uo pipefail

SRC="${VELAB_VAULT:-/opt/velab/vault}"
STAGE="${VELAB_BACKUP_STAGE:-/opt/velab/backups/vault-git}"
REMOTE="${VELAB_BACKUP_REMOTE:-git@github.com:YOUR-ORG/your-backup-repo.git}"
LOG="$SRC/os/schedule/logs/velab-vault-push.log"
LOCKDIR=/tmp/velab-vault-push.lock
TRIGGER="${1:-manual}"

mkdir -p "$STAGE" "$(dirname "$LOG")"
log(){ echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

# single-flight — timer and session hooks can fire concurrently
if ! mkdir "$LOCKDIR" 2>/dev/null; then log "push already running; skip ($TRIGGER)"; exit 0; fi
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

log "vault-push START (trigger: $TRIGGER)"

# one-time git init
if [ ! -d "$STAGE/.git" ]; then
  git init -q -b main "$STAGE"
  git -C "$STAGE" remote add origin "$REMOTE" 2>/dev/null || git -C "$STAGE" remote set-url origin "$REMOTE"
  printf '%s\n' '*/node_modules/' '*/__pycache__/' '*.pyc' \
    'os/mirror/systemd/claude-remote.service' > "$STAGE/.gitignore"
fi

# sync vault -> staging root, EXCLUDING secrets + junk (keep .git/.gitignore).
# --exclude='/workspace' '/core' '/valence-console' so --delete here doesn't wipe the
# non-vault trees synced by their own blocks below.
rsync -a --delete \
  --exclude='.git' --exclude='.gitignore' \
  --exclude='/workspace' --exclude='/core' --exclude='/valence-console' --exclude='/dot-velab' \
  --exclude='os/mirror/systemd/claude-remote.service' \
  --exclude='*/node_modules' --exclude='*/__pycache__' --exclude='*.pyc' \
  "$SRC/" "$STAGE/"

# sync the live workspace SKILLS into the repo (node_modules excluded — each skill that
# needs one has package.json, so `npm install` restores it on recovery). tools/ are already
# covered via vault/os/mirror/workspace-tools. .git excluded: an embedded repo becomes a
# bare gitlink pointer, so its CONTENT would silently never reach GitHub (ultra-scraping bug).
mkdir -p "$STAGE/workspace/skills"
rsync -a --delete \
  --exclude='.git' --exclude='node_modules' --exclude='__pycache__' --exclude='*.pyc' \
  ${VELAB_HOME:-/opt/velab}/workspace/skills/ "$STAGE/workspace/skills/"

# sync the CORE rebuild package (truth engine v2, 2026-07-02) — real files, off-server.
mkdir -p "$STAGE/core"
rsync -a --delete \
  --exclude='.git' --exclude='__pycache__' --exclude='*.pyc' \
  ${VELAB_HOME:-/opt/velab}/core/ "$STAGE/core/"

# sync the CUSTOMER CARE realm (${VELAB_CARE:-/opt/velab/care-realm}: care mailbox, google meeting state) —
# added 2026-07-12 after the agent-file audit found it locally backed but with NO
# off-server copy. Credentials NEVER leave the box: secret.env, .vncpass,
# .sync-proxy-pass, google/oauth_client.json, google/token.json and the Chromium
# sync-profile are excluded; the secret scan below backstops.
mkdir -p "$STAGE/dot-velab"
rsync -a --delete \
  --exclude='.git' --exclude='__pycache__' --exclude='*.pyc' \
  --exclude='secret.env' --exclude='.vncpass' --exclude='.sync-proxy-pass' \
  --exclude='google/oauth_client.json' --exclude='google/token.json' \
  --exclude='sync-profile' \
  ${VELAB_CARE:-/opt/velab/care-realm}/ "$STAGE/dot-velab/"

# sync the VALENCE CONSOLE source (unified 2026-07-06; replaces the separate
# velab-valence-console repo + velab-valence-push timer). History up to unification was
# subtree-merged under valence-console/; from here on the mirror keeps it current.
# First commit the console's in-place repo so a granular local history survives on-disk;
# then mirror the source (never .git/.env*/deps/build) into the unified repo.
if [ -d ${VELAB_HOME:-/opt/velab}/valence-console/.git ]; then
  git -C ${VELAB_HOME:-/opt/velab}/valence-console add -A
  git -C ${VELAB_HOME:-/opt/velab}/valence-console diff --cached --quiet || \
    git -C ${VELAB_HOME:-/opt/velab}/valence-console \
      -c user.name="velab-backup" -c user.email="backup@example.com" \
      commit -q -m "valence console backup $(date -u +%Y-%m-%dT%H:%M:%SZ) [$TRIGGER]"
fi
mkdir -p "$STAGE/valence-console"
rsync -a --delete \
  --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='.env*' \
  --exclude='__pycache__' --exclude='*.pyc' \
  ${VELAB_HOME:-/opt/velab}/valence-console/ "$STAGE/valence-console/"

# SECRET SCAN backstop — high-confidence VALUE patterns (not env-var names).
# ALLOWLIST: docs that legitimately quote a key HEADER as an illustration (no key body).
ALLOW='os/llm-shell/context/memory/feedback_ssh_key_handling.md'
HITS=$(grep -rIlE \
  'sk-ant-[a-zA-Z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pous]_[0-9A-Za-z]{30,}|xox[baprs]-[0-9A-Za-z-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"refresh_token"[[:space:]]*:[[:space:]]*"[^"]{20,}"' \
  "$STAGE" 2>/dev/null | grep -v '/\.git/' | grep -vF "$ALLOW")
if [ -n "$HITS" ]; then
  log "ABORT: credential-shaped content found, NOT pushing:"; printf '%s\n' "$HITS" | tee -a "$LOG"
  exit 1
fi

cd "$STAGE"
git add -A
if git diff --cached --quiet; then log "no changes; nothing to push ($TRIGGER)"; exit 0; fi
git -c user.name="velab-backup" -c user.email="backup@example.com" \
    commit -q -m "vault backup $(date -u +%Y-%m-%dT%H:%M:%SZ) [$TRIGGER]"
if git push -q origin HEAD:main 2>>"$LOG"; then
  log "vault-push OK ($(git rev-parse --short HEAD)) -> $REMOTE"
else
  log "vault-push FAILED — see log"; exit 1
fi
log "vault-push DONE ($TRIGGER)"
