import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { startJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Claude stores per-cwd transcripts here for cwd=/root.
const SESSION_DIR = `${process.env.HOME || ""}/.claude/projects/-root`;
// Human titles live in a cache the background titler maintains — the operator
// never reads raw prompt first-lines (brief 2, directive 2).
const TITLE_CACHE = "/opt/velab/vault/os/sessions/chat-titles.json";
const TITLE_LOCK = "/opt/velab/workspace/runs/workbench/titling.lock";
const WB = "/opt/velab/workspace/tools/cockpit_workbench.sh";

interface SessionInfo { id: string; title: string; mtime: number }

function readTitleCache(): Record<string, string> {
  try { return JSON.parse(fsSync.readFileSync(TITLE_CACHE, "utf8")); } catch { return {}; }
}

// First real user message — the raw material for a title (never shown as-is
// unless the cache has nothing better; then it's cleaned up heuristically).
async function firstUserText(file: string): Promise<string> {
  let fh;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "summary" && typeof ev.summary === "string") return ev.summary;
      if (ev.type === "user") {
        const msg = ev.message as { content?: unknown } | undefined;
        let text = "";
        const c = msg?.content;
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) {
          const t = c.find((b) => (b as { type?: string }).type === "text") as { text?: string } | undefined;
          text = t?.text ?? "";
        }
        text = text.trim();
        if (!text || text.startsWith("<") || text.startsWith("Caveat:")) continue;
        return text;
      }
    }
  } catch { /* ignore */ } finally { await fh?.close(); }
  return "";
}

// Heuristic cleanup for sessions the titler hasn't reached yet: strip markdown
// and command wrappers, cut at a word boundary, capitalize.
function heuristicTitle(raw: string): string {
  let t = raw.replace(/^#+\s*/, "").replace(/[`*_>]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return "Untitled session";
  if (t.startsWith("/")) t = t.split(" ")[0]; // slash command → its name
  if (t.length > 64) {
    t = t.slice(0, 64);
    const cut = t.lastIndexOf(" ");
    if (cut > 30) t = t.slice(0, cut);
    t += "…";
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Fire ONE background titling run over whatever sessions currently lack a
// human title. Operator-fired only (POST /api/sessions {action:"title"}) — no
// auto-gate on count, per doctrine tenet 25 (agent runs are opt-in per click).
// The agent merges (never clobbers) the cache file; a lock stops re-spawning
// while a run is already in flight.
function spawnTitler(untitled: { id: string; raw: string }[]): { started: boolean; jobId?: string; reason?: string } {
  if (untitled.length === 0) return { started: false, reason: "Every session already has a title." };
  try {
    const st = fsSync.statSync(TITLE_LOCK);
    if (Date.now() - st.mtimeMs < 15 * 60_000) {
      return { started: false, reason: "A titling run is already in flight — give it a minute and try again." };
    }
  } catch { /* no lock yet */ }
  try {
    fsSync.mkdirSync(path.dirname(TITLE_LOCK), { recursive: true });
    fsSync.writeFileSync(TITLE_LOCK, new Date().toISOString());
    const prompt = `You are titling console chat sessions. Work headlessly and finish.

Below are session ids with the first user message of each. Write a SHORT human title
for every one: 2–6 words, plain language, capitalized first letter, fix typos, no
markdown, no trailing punctuation. Examples: "Console audit & redesign",
"Draft reply · Lyra", "Inbox check".

${untitled.map((u) => `${u.id}: ${u.raw.slice(0, 160).replace(/\n/g, " ")}`).join("\n")}

TASK: Read ${TITLE_CACHE} if it exists (treat missing/invalid as {}). MERGE your new
titles into that object (never drop existing keys) and Write the merged JSON back to
${TITLE_CACHE}. Then print DONE and stop.`;
    const promptFile = TITLE_LOCK.replace(/\.lock$/, `.prompt-${Date.now().toString(36)}.md`);
    fsSync.writeFileSync(promptFile, prompt, "utf8");
    const jobId = startJob({ label: "workbench-titles", argv: [WB, promptFile], cwd: "/opt/velab/workspace" });
    return { started: true, jobId };
  } catch {
    return { started: false, reason: "Could not start the titling run." };
  }
}

// ── transcript reader: the resumed session's REAL history ───────────────────
interface Turn { role: "user" | "valence"; text: string; tools: string[] }
async function readTranscript(id: string): Promise<Turn[]> {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return [];
  const file = path.join(SESSION_DIR, `${id}.jsonl`);
  let raw = "";
  try { raw = await fs.readFile(file, "utf8"); } catch { return []; }
  const turns: Turn[] = [];
  let current: Turn | null = null; // the assistant turn being accumulated
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { continue; }
    const msg = ev.message as { content?: unknown } | undefined;
    if (ev.type === "user") {
      const c = msg?.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        // tool_result-only "user" events are plumbing, not operator words
        const t = c.filter((b) => (b as { type?: string }).type === "text") as { text?: string }[];
        text = t.map((b) => b.text ?? "").join("\n");
      }
      text = text.trim();
      if (!text || text.startsWith("<") || text.startsWith("Caveat:")) continue;
      // hidden dossier context travels prepended — show only the operator's words
      const split = text.split("\n\n---\n\n");
      turns.push({ role: "user", text: split[split.length - 1].slice(0, 4000), tools: [] });
      current = null;
    } else if (ev.type === "assistant") {
      const c = msg?.content;
      if (!Array.isArray(c)) continue;
      if (!current) { current = { role: "valence", text: "", tools: [] }; turns.push(current); }
      for (const b of c as { type?: string; text?: string; name?: string }[]) {
        if (b.type === "text" && b.text) current.text += (current.text ? "\n\n" : "") + b.text;
        else if (b.type === "tool_use" && b.name) current.tools.push(b.name);
      }
    }
  }
  // drop empty assistant shells (tool-only turns keep their tool chips)
  return turns.filter((t) => t.text.trim() || t.tools.length).slice(-200);
}

// The sessions list + which of them still lack a human title. Shared by GET
// (display only) and POST (the operator-fired titling run).
async function listSessions(): Promise<{ sessions: SessionInfo[]; untitled: { id: string; raw: string }[] }> {
  let entries: string[];
  try {
    entries = (await fs.readdir(SESSION_DIR)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { sessions: [], untitled: [] };
  }

  const stats = await Promise.all(
    entries.map(async (f) => {
      const full = path.join(SESSION_DIR, f);
      const st = await fs.stat(full).catch(() => null);
      return st ? { f, full, mtime: st.mtimeMs } : null;
    }),
  );

  const recent = stats
    .filter((s): s is { f: string; full: string; mtime: number } => !!s)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 40);

  const cache = readTitleCache();
  const untitled: { id: string; raw: string }[] = [];
  const sessions: SessionInfo[] = await Promise.all(
    recent.map(async ({ f, full, mtime }) => {
      const id = f.replace(/\.jsonl$/, "");
      if (cache[id]) return { id, title: cache[id], mtime };
      const raw = await firstUserText(full);
      if (raw) untitled.push({ id, raw });
      return { id, title: heuristicTitle(raw), mtime };
    }),
  );
  return { sessions, untitled };
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) return NextResponse.json({ id, turns: await readTranscript(id) });

  // Display only — never spawns the titler (that's an explicit operator click now).
  const { sessions } = await listSessions();
  return NextResponse.json({ sessions });
}

interface SessionsAction { action?: "title" }

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as SessionsAction;
  if (body.action !== "title") return NextResponse.json({ error: "unknown action" }, { status: 400 });

  const { untitled } = await listSessions();
  const result = spawnTitler(untitled);
  return NextResponse.json({ ok: result.started, jobId: result.jobId, count: untitled.length, message: result.reason });
}
