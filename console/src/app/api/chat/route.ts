import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { checkBash, checkFileTool } from "@/lib/chatGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

// Valence's identity for an SDK-driven turn. The vault + skills are reachable
// because cwd is /root; this just sets the persona + the cardinal rule.
const VALENCE_SYSTEM = `You are Valence — central command for the Velab agent organization (VenusOS V2).
You are the operator's single interface. You can read the vault, run the slash-command library,
and dispatch work. Cardinal rule: NEVER send email or grant a send on your own — sends are
default-DENY behind the operator's verbatim approval. You surface, recommend, and route; the
operator decides. Be concise and lead with the answer.`;

interface ChatBody {
  prompt?: string;
  sessionId?: string | null;
  // Optional hidden dossier (e.g. a company's board row or a draft pack) prepended
  // to the prompt server-side. The client renders only `prompt` in the bubble, so
  // the cockpit can bind rich context to a revision turn without cluttering the UI.
  context?: string;
}

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// Optional hard lockdown: set COCKPIT_CHAT_READONLY=1 in the unit to strip the
// chat's execute/mutate tools entirely (Bash/Write/Edit/NotebookEdit), leaving
// only read/search/fetch. Default is OFF so Valence can still run slash-commands
// and dispatch work; canUseTool + the widened chatGuard denylist remain the
// fence when it's off. Flip it on to trade that dispatch power for max safety.
const READONLY_TOOLS = process.env.COCKPIT_CHAT_READONLY === "1";
const MUTATING_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit"];

// The chat fence (see lib/chatGuard.ts for what it checks and why): blocks the
// chat agent from reading/writing the operator's live credentials, and keeps
// writes inside /opt/velab. It is a heuristic, not a sandbox — full tool
// access is otherwise granted (bypassPermissions fails as root). The send
// gate is separate and untouched (smtp default-deny + grant_send.py).
async function canUseTool(name: string, input: Record<string, unknown>): Promise<PermissionResult> {
  const verdict = name === "Bash" ? checkBash(typeof input.command === "string" ? input.command : "") : checkFileTool(name, input);
  if (!verdict.ok) return { behavior: "deny", message: verdict.message };
  return { behavior: "allow", updatedInput: input };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as ChatBody;
  const userText = (body.prompt ?? "").trim();
  const ctx = (body.context ?? "").trim();
  const prompt = ctx ? `${ctx}\n\n---\n\n${userText}` : userText;
  const resume = body.sessionId && body.sessionId !== "new" ? body.sessionId : undefined;

  if (!userText) return new Response("empty prompt", { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: Record<string, unknown>) => controller.enqueue(encoder.encode(sse(e)));
      let sessionId = resume ?? "";
      try {
        for await (const m of query({
          prompt,
          options: {
            resume,
            cwd: process.env.VELAB_ROOT ?? "/opt/velab",
            // apply Valence's persona + cardinal never-send rule by APPENDING to the
            // claude_code preset (a bare string would replace the preset and strip the
            // tool/command instructions the chat relies on). New session only; resumed
            // sessions keep their persisted prompt.
            ...(resume ? {} : { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: VALENCE_SYSTEM } }),
            // full-power by default (bypassPermissions fails as root) — canUseTool is
            // the fence that stops it short of secrets/off-vault writes. Real sends
            // are still default-DENY at the smtp/grant layer regardless.
            ...(READONLY_TOOLS ? { disallowedTools: MUTATING_TOOLS } : {}),
            canUseTool,
            includePartialMessages: true,
            settingSources: ["user", "project"], // load the slash-command + skill library
          },
        })) {
          if (m.type === "system" && m.subtype === "init") {
            sessionId = m.session_id;
            send({ type: "session", sessionId });
          } else if (m.type === "stream_event") {
            // partial assistant text deltas → live typing
            const ev = m.event as { type?: string; delta?: { type?: string; text?: string } };
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              send({ type: "delta", text: ev.delta.text });
            }
          } else if (m.type === "assistant") {
            for (const b of m.message.content) {
              if (b.type === "tool_use") {
                send({ type: "tool", name: b.name, input: b.input });
              }
            }
          } else if (m.type === "result") {
            send({ type: "done", sessionId, subtype: m.subtype });
          }
        }
      } catch (e) {
        send({ type: "error", message: (e as Error)?.message?.slice(0, 300) ?? "query failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
