import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pexec = promisify(exec);
const SNAP_DIR = "/opt/velab/backups/velab/";
const GIT_MIRROR = "/opt/velab/backups/vault-git";
const BACKUP_SCRIPT = "/opt/velab/workspace/tools/velab_backup.sh";

async function sh(cmd: string): Promise<string> {
  try { return (await pexec(cmd, { timeout: 8000 })).stdout.trim(); } catch { return ""; }
}

export async function GET() {
  // --- snapshots ---
  let snapshots: { name: string; bytes: number; mtime: number }[] = [];
  try {
    const files = (await fs.readdir(SNAP_DIR)).filter((f) => f.endsWith(".tar.gz"));
    snapshots = await Promise.all(
      files.map(async (name) => {
        const st = await fs.stat(SNAP_DIR + name);
        return { name, bytes: st.size, mtime: st.mtimeMs };
      }),
    );
    snapshots.sort((a, b) => b.mtime - a.mtime);
  } catch { /* */ }
  const totalBytes = snapshots.reduce((s, x) => s + x.bytes, 0);
  const latest = snapshots[0] ?? null;

  // --- timer (last / next run) — systemctl prints human dates; parse by key ---
  const timerRaw = await sh(
    "systemctl show velab-backup.timer -p LastTriggerUSec -p NextElapseUSecRealtime 2>/dev/null",
  );
  const timerActive = (await sh("systemctl is-active velab-backup.timer")) === "active";
  const pick = (key: string): number | null => {
    const line = timerRaw.split("\n").find((l) => l.startsWith(key + "="));
    if (!line) return null;
    const val = line.slice(key.length + 1).trim();
    const t = Date.parse(val);
    return Number.isNaN(t) ? null : t;
  };
  const lastTrig = pick("LastTriggerUSec");
  const nextTrig = pick("NextElapseUSecRealtime");

  // --- off-server git mirror (granular) ---
  const gitLast = await sh(`cd ${GIT_MIRROR} && git log -1 --format='%ct|%h|%an|%s' 2>/dev/null`);
  const [gitTs, gitHash, gitAuthor, ...gitMsgParts] = gitLast.split("|");
  const gitDirty = (await sh(`cd ${GIT_MIRROR} && git status --porcelain 2>/dev/null | wc -l`)) || "0";
  const gitBranch = await sh(`cd ${GIT_MIRROR} && git rev-parse --abbrev-ref HEAD 2>/dev/null`);
  const gitCommits = Number(await sh(`cd ${GIT_MIRROR} && git rev-list --count HEAD 2>/dev/null`)) || 0;
  const gitRepoSize = await sh(`du -sh ${GIT_MIRROR}/.git 2>/dev/null | cut -f1`);
  // recent push history — the last several commits, each = one mirror push
  const gitLogRaw = await sh(`cd ${GIT_MIRROR} && git log -8 --format='%ct|%h|%s' 2>/dev/null`);
  const gitHistory = gitLogRaw.split("\n").filter(Boolean).map((l) => {
    const [ts, hash, ...msg] = l.split("|");
    return { ts: Number(ts) * 1000, hash, msg: msg.join("|") };
  });
  // the event-driven vault-push service (session hooks) — last run
  const pushRaw = await sh("systemctl show velab-vault-push.service -p ActiveEnterTimestamp -p ExecMainStatus 2>/dev/null");
  const pushTsLine = pushRaw.split("\n").find((l) => l.startsWith("ActiveEnterTimestamp="));
  const pushLast = pushTsLine ? (Date.parse(pushTsLine.slice("ActiveEnterTimestamp=".length).trim()) || null) : null;

  // --- integrity guard params (from the script) ---
  const grab = async (key: string) => {
    const v = await sh(`grep -m1 '^${key}=' ${BACKUP_SCRIPT} 2>/dev/null | grep -oE '[0-9]+' | head -1`);
    return v ? Number(v) : null;
  };
  const keep = await grab("KEEP");
  const skillsFloor = await grab("SKILLS_FLOOR");
  const memoryFloor = await grab("MEMORY_FLOOR");

  // --- vault footprint (data integrity at a glance) ---
  const vaultFiles = Number(await sh("find /opt/velab/vault -type f 2>/dev/null | wc -l")) || 0;
  const vaultSize = await sh("du -sh /opt/velab/vault 2>/dev/null | cut -f1");
  const mdFiles = Number(await sh("find /opt/velab/vault -name '*.md' 2>/dev/null | wc -l")) || 0;

  // --- health verdict ---
  const latestAgeH = latest ? (Date.now() - latest.mtime) / 3.6e6 : Infinity;
  const backupOk = latestAgeH < 8; // 4x/day = every 6h
  const gitAgeH = gitTs ? (Date.now() - Number(gitTs) * 1000) / 3.6e6 : Infinity;

  return NextResponse.json({
    ranAt: Date.now(),
    backups: {
      ok: backupOk,
      timerActive,
      schedule: "4× / day (every 6h)",
      lastTrigger: lastTrig,
      nextTrigger: nextTrig,
      count: snapshots.length,
      keep,
      totalBytes,
      // exposure trim (audit 2026-07-10): dates + sizes tell the operator
      // everything; exact archive filenames don't belong on an open endpoint
      latest: latest ? { bytes: latest.bytes, mtime: latest.mtime } : null,
      snapshots: snapshots.slice(0, 16).map((s) => ({ bytes: s.bytes, mtime: s.mtime })),
    },
    offsite: {
      ok: gitAgeH < 26,
      // remote URL (account + private repo name) dropped from the payload —
      // never rendered by the UI, no business on an open endpoint
      branch: gitBranch,
      lastCommitTs: gitTs ? Number(gitTs) * 1000 : null,
      lastCommitMsg: gitMsgParts.join("|"),
      lastCommitHash: gitHash || null,
      lastCommitAuthor: gitAuthor || null,
      dirtyFiles: Number(gitDirty),
      totalCommits: gitCommits,
      repoSize: gitRepoSize || null,
      history: gitHistory,
      pushServiceLast: pushLast,
    },
    integrity: {
      wipeGuard: skillsFloor !== null || memoryFloor !== null,
      skillsFloor,
      memoryFloor,
      retention: keep ? `${keep} snapshots (~${(keep / 4).toFixed(0)} days)` : null,
    },
    vault: { files: vaultFiles, sizeHuman: vaultSize, mdFiles },
  });
}
