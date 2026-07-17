// Chat fence for the Valence chat session (src/app/api/chat/route.ts). The chat
// runs with every tool allowed (bypassPermissions fails as root — see route.ts),
// so this module is what stands between a chat turn and the filesystem: block
// reads/writes of the operator's live credentials, and keep writes inside
// /opt/velab (the vault + workspace the operator actually reviews).
//
// This is a HEURISTIC FENCE, not a sandbox. It pattern-matches tool inputs and
// Bash command strings; a determined or confused agent can still route around
// it (symlinks, unusual quoting, a tool this file doesn't know about). It exists
// to catch the ordinary case, not to replace the real security boundary.
//
// The send gate is untouched by this file and lives elsewhere: smtp.js is
// default-DENY and only grant_send.py can mint a send ticket. Nothing here
// grants, weakens, or routes around that gate.
import path from "node:path";

export type GuardResult = { ok: true } | { ok: false; message: string };

function deny(message: string): GuardResult {
  return { ok: false, message };
}

// Live credentials and secrets — off-limits to read OR write, from any tool.
// A tricked agent (indirect prompt injection from email / scraped content it
// reads) could otherwise exfiltrate credentials from the home directory and
// standard credential locations. findSecretHit substring-matches these against
// every tool input and Bash command string.
//
// The paths below are generic placeholders — replace them with your
// deployment's real home and credential locations. HOME defaults to a neutral
// deploy root and is overridable via env.
const HOME = process.env.VELAB_HOME ?? "/opt/velab";
const SECRET_PATHS = [
  `${HOME}/.ssh`,
  `${HOME}/.credentials`,            // provider / CLI credential store
  `${HOME}/.example-service.env`,    // e.g. a CRM/webhook token file
  `${HOME}/.config/mail-agent`,      // e.g. IMAP/SMTP credentials
  `${HOME}/.config/oauth`,           // e.g. OAuth client/token JSON
  `${HOME}/secrets`,
  // shell profiles and dotfiles commonly hold credentials — deny by default
  `${HOME}/.bashrc`,
  `${HOME}/.bash_profile`,
  `${HOME}/.profile`,
  `${HOME}/.bash_history`,
  // standard credential stores
  `${HOME}/.aws`,
  `${HOME}/.config`,
  `${HOME}/.gnupg`,
  `${HOME}/.netrc`,
  `${HOME}/.git-credentials`,
  `${HOME}/.docker/config.json`,
  `${HOME}/.env`,
];

// Tools that can write files. Everything else (Read, Grep, Glob, WebFetch, …)
// only needs the secret-path check above.
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

// Path-shaped fields these tools send their target in.
const PATH_FIELDS = ["file_path", "path", "notebook_path"];

const VAULT_ROOT = "/opt/velab";
const CHAT_CWD = process.env.VELAB_ROOT ?? "/opt/velab"; // matches route.ts's query cwd

function stripQuotes(t: string): string {
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Resolve a path the way a shell/tool would from the chat's cwd: ~ → /root,
// relative → against /root, everything through path.resolve to fold ../ etc.
function resolvePath(raw: string): string {
  let p = raw;
  if (p === "~") p = CHAT_CWD;
  else if (p.startsWith("~/")) p = path.join(CHAT_CWD, p.slice(2));
  if (!path.isAbsolute(p)) p = path.resolve(CHAT_CWD, p);
  return path.resolve(p);
}

function isUnderVault(abs: string): boolean {
  return abs === VAULT_ROOT || abs.startsWith(VAULT_ROOT + path.sep);
}

function findSecretHit(haystack: string): string | undefined {
  return SECRET_PATHS.find((p) => haystack.includes(p));
}

function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

// Every non-Bash tool call — Read, Write, Edit, Grep, NotebookEdit, etc.
export function checkFileTool(toolName: string, input: unknown): GuardResult {
  const hit = findSecretHit(safeStringify(input));
  if (hit) {
    return deny(`That touches a protected file (${hit}) the chat isn't allowed to read or write. Ask the operator directly if you need it.`);
  }

  if (WRITE_TOOLS.has(toolName) && input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    for (const field of PATH_FIELDS) {
      const val = rec[field];
      if (typeof val !== "string" || !val.trim()) continue;
      const abs = resolvePath(val);
      if (!isUnderVault(abs)) {
        return deny(`This chat can only write inside /opt/velab — "${val}" resolves outside it.`);
      }
    }
  }

  return { ok: true };
}

// Leading write verbs (checked at the start of each `&&`/`;`/`|`-separated
// segment) — the shell equivalents of the WRITE_TOOLS above.
const WRITE_VERB_RES = [
  /^rm\b/, /^mv\b/, /^cp\b/, /^mkdir\b/, /^touch\b/, /^sed\s+-i\b/, /^tee\b/,
  /^dd\b/, /^truncate\b/, /^chmod\b/, /^chown\b/, /^ln\b/, /^rsync\b/,
  /^tar\s+\S*x\S*\b/, /^unzip\b/,
  /^(npm|pnpm|yarn)\s+(install|add|i)\b/, /^pip3?\s+install\b/,
  /^git\s+(add|commit|checkout|reset|clean|apply|mv|rm)\b/,
];
// Any redirect (>, >>) or a pipe into tee also means the command writes.
const REDIRECT_RE = />>?|\|\s*tee\b/;

function looksWriteShaped(cmd: string): boolean {
  if (REDIRECT_RE.test(cmd)) return true;
  return cmd.split(/&&|;|\|/).some((seg) => WRITE_VERB_RES.some((re) => re.test(seg.trim())));
}

// A leading `cd <path> &&` / `cd <path>;` sets the effective cwd for a
// write-shaped command with no absolute path tokens of its own.
function leadingCwd(cmd: string): string {
  const m = cmd.match(/^\s*cd\s+(\S+)\s*(?:&&|;)/);
  return m ? resolvePath(stripQuotes(m[1])) : CHAT_CWD;
}

export function checkBash(command: string): GuardResult {
  const cmd = (command ?? "").toString();

  const hit = findSecretHit(cmd);
  if (hit) {
    return deny(`That command mentions a protected file (${hit}) the chat isn't allowed to touch. Ask the operator directly if you need it.`);
  }

  if (!looksWriteShaped(cmd)) return { ok: true };

  const tokens = cmd.split(/\s+/).map(stripQuotes);
  const absTokens = tokens.filter((t) => t.startsWith("/") || t.startsWith("~/") || t === "~");

  if (absTokens.length > 0) {
    for (const t of absTokens) {
      const abs = resolvePath(t);
      if (!isUnderVault(abs)) {
        return deny(`This command writes to "${t}", which is outside /opt/velab. Point it at a path under /opt/velab instead.`);
      }
    }
    return { ok: true };
  }

  const cwd = leadingCwd(cmd);
  if (!isUnderVault(cwd)) {
    return deny('This command writes files but doesn\'t say where — run "cd /opt/velab/…" first, or give it an explicit path under /opt/velab.');
  }
  return { ok: true };
}
