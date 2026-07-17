// Shared server-only helpers for the cockpit API routes. Centralizes the vault /
// workspace roots, a JSON-emitting tool runner, and a path guard so every route
// reuses the same proven pattern (the /api/agent/file safePath model).
import { execFile } from "node:child_process";
import path from "node:path";

// Deployment sets the real roots via env; defaults are neutral placeholders.
const VELAB_HOME = process.env.VELAB_HOME || "/opt/velab";
export const VAULT = process.env.VELAB_VAULT || `${VELAB_HOME}/vault`;
export const WORKSPACE = process.env.VELAB_WORKSPACE || `${VELAB_HOME}/workspace`;
export const TOOLS = `${WORKSPACE}/tools`;
export const PY = process.env.VELAB_PYTHON || "/usr/bin/python3";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Run a command, capture stdout/stderr. Never throws on non-zero exit — the caller
// inspects code. Bounded timeout + output so a stuck tool can't wedge a request.
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd ?? WORKSPACE, timeout: opts.timeout ?? 30_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
      },
    );
  });
}

// Run a tool expected to emit JSON on stdout; parse it. Returns null on failure.
export async function runJson<T = unknown>(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<{ ok: boolean; data: T | null; raw: RunResult }> {
  const raw = await run(cmd, args, opts);
  try {
    return { ok: true, data: JSON.parse(raw.stdout) as T, raw };
  } catch {
    return { ok: false, data: null, raw };
  }
}

// Resolve a user-supplied path against an allowed root; reject traversal / escapes.
// Mirrors /api/agent/file's safePath. Returns the absolute path or null.
export function safeUnder(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  const base = path.resolve(root);
  if (resolved === base || resolved.startsWith(base + path.sep)) return resolved;
  return null;
}
