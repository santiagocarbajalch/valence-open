import fs from "node:fs";
import path from "node:path";
import { run, runJson, TOOLS, PY, VAULT, WORKSPACE, safeUnder } from "@/lib/vault";
import { DRAFTS_DIR, companyKey, readDecisions } from "@/lib/pipeline";
import { startJob } from "@/lib/jobs";
import { suggestAttachments, validateAssetPaths } from "@/lib/assetsLib";
import { SALES_TERMS } from "@/lib/salesTerms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// THE DRAFT WORKBENCH — the LLM baked into the cockpit as a feature, not a chat.
// Every action runs ONE headless agent turn detached (cockpit_workbench.sh, the
// proven archivist `claude -p` pattern) and the artifacts on disk are the result:
//   draft-row   → agent grounds in the thread, writes a dated reply pack.
//                 Optional `instruction` (e.g. the warm-nudge gold standard)
//                 rides into the prompt verbatim.
//   draft-day   → agent runs the /draft brain over ALL decided-but-undrafted items.
//   revise      → agent writes ONLY a result JSON; apply_revision.py applies it
//                 deterministically to base+twin, clears the staged marker, and
//                 appends the exchange to the entry's _revisions log.
//   revise-group→ same contract over a WHOLE single-variant cold pack (the only
//                 pack kind where one template honestly is every draft): the
//                 agent rewrites the shared body once with an {institution}
//                 placeholder; apply_revision.py --entry all renders it per
//                 recipient. Subjects never move (per-entry thread anchors).
//   investigate → agent digs the thread and records durable facts via lead_note.py.
//   operator-instruct → ONE free-form operator instruction, scoped to ONE
//                 company (V4.2 command box). The agent gets the same dossier
//                 draft-row uses + the FULL thread + HOUSE_RULES and must end
//                 with an OPERATOR_RESULT line: a one-company draft pack, a
//                 proposed directive (UI confirms → /api/directive), or a
//                 plain-language answer. It can never stage, send, or write
//                 registries itself.
// The client polls /api/job and reloads packs/board — no sidecar, no SSE chat.

const RUNS = path.join(WORKSPACE, "runs/workbench");
const WB = path.join(TOOLS, "cockpit_workbench.sh");
const CORE = "/opt/velab/core";
const KEY_RX = /^[\w.@+-]{1,120}$/; // company key or freemail mailbox (same as /api/thread)

interface Company {
  domain: string; people?: string[]; bucket?: string; suppressed?: string | null;
  last_in_from?: string; last_in_date?: string; last_in_text?: string; last_in_subj?: string;
  last_out_date?: string; last_out_text?: string; deliverables?: string[];
  ask_gist?: string | null; key_facts?: Record<string, string[]> | null;
  notes?: { ts?: string; kind?: string; note?: string; by?: string }[];
  enrich_summary?: string | null; enrich_next?: string | null; signals?: string[]; state?: string;
}

const HOUSE_RULES = `VELAB HOUSE RULES (non-negotiable):
- OPERATOR AUTHORITY: this run was fired by the operator from his console — that IS the
  approval (operator ruling 2026-07-11). Do the requested work; never refuse it. If you have
  concerns (junk inbound, wrong move, risky wording), do the work anyway and state the concern
  in one plain ADVICE: line — the operator decides. Only the send gate decides what leaves.
- Reply in the client's language. Ground every claim in the actual thread — never invent.
- VELAB is an American BRAND — never call it a "manufacturer" or say it "manufactures"
  (the 2026-07-12 test reply violated this). Sales conditions are EXW, exact phrase only.
  When the client asks about sales/commercial conditions, state them with EXACTLY this
  sentence and nothing more: ES "${SALES_TERMS.es}" / EN "${SALES_TERMS.en}"
  — never add currency, city, Incoterm place, or validity windows.
- One idea per short paragraph, blank line between paragraphs. Soft asks: ONE light sentence,
  no pile of hedges. Never push files or time-box slots on a soft follow-up.
- Established replies KEEP the original subject (with Re:) — changing it splits the Gmail thread.
- NEVER send or stage anything. You only write draft pack files. Sends are operator-gated.
- The drafting contract lives at the drafting contract (commands/draft.md) — consult it if unsure.`;

function dossier(c: Company): string {
  const notes = (c.notes ?? []).filter((n) => n.kind !== "decision");
  const facts = c.key_facts
    ? Object.entries(c.key_facts).map(([k, v]) => `${k}: ${(Array.isArray(v) ? v : [v]).join(", ")}`).join(" · ")
    : "";
  return [
    `Company: ${c.domain}`,
    `People: ${(c.people ?? []).join(", ")}`,
    `State: ${c.state ?? ""} · signals: ${(c.signals ?? []).join(", ") || "none"}`,
    `Their last message (${c.last_in_date ?? "—"}, from ${c.last_in_from ?? "—"}, subject "${c.last_in_subj ?? ""}"):\n${c.last_in_text ?? "—"}`,
    c.ask_gist ? `Their ask (gist): ${c.ask_gist}` : "",
    (c.deliverables ?? []).length ? `They asked us for: ${c.deliverables!.join(", ")}` : "",
    `Our last reply (${c.last_out_date || "none"}):\n${c.last_out_text || "— we have not replied —"}`,
    facts ? `Key facts on file: ${facts}` : "",
    notes.length ? `Durable notes:\n${notes.map((n) => `- ${(n.ts ?? "").slice(0, 10)} · ${n.by ?? "?"} · [${n.kind}] ${n.note}`).join("\n")}` : "",
    c.enrich_summary ? `Archivist summary: ${c.enrich_summary}` : "",
    c.enrich_next ? `Archivist suggested next: ${c.enrich_next}` : "",
  ].filter(Boolean).join("\n");
}

// Freeze/close and drafting are mutually enforced (V4.1 Phase 10): a paused or
// closed company can't be drafted at until the operator reactivates it. Mirrors
// truth.py's registry keying (company_key of email-or-domain).
function gatedState(domainOrEmail: string): "frozen" | "closed" | null {
  const key = companyKey(domainOrEmail);
  try {
    const f = JSON.parse(fs.readFileSync(path.join(VAULT, "pipeline/operator-frozen.json"), "utf8")) as { frozen?: { domain?: string; email?: string }[] };
    for (const e of f.frozen ?? []) if (companyKey(e.email || e.domain || "") === key) return "frozen";
  } catch { /* no registry */ }
  try {
    const c = JSON.parse(fs.readFileSync(path.join(VAULT, "pipeline/closed.json"), "utf8")) as { closed?: unknown };
    const rows = (c.closed ?? c) as Record<string, unknown> | { domain?: string }[];
    if (Array.isArray(rows)) { for (const e of rows) if (e?.domain && companyKey(e.domain) === key) return "closed"; }
    else for (const k of Object.keys(rows)) if (companyKey(k) === key) return "closed";
  } catch { /* no registry */ }
  return null;
}
const gatedMsg = (who: string, g: "frozen" | "closed") =>
  `${who} is ${g === "frozen" ? "paused (frozen)" : "closed out"} — reactivate it from System status before drafting at it`;

async function loadCompanies(): Promise<Company[]> {
  const { ok, data } = await runJson<{ companies: Company[] }>(
    PY, ["company_state.py", "--json", "--cache-only"], { cwd: TOOLS, timeout: 45_000 },
  );
  if (!ok || !data) throw new Error("company_state failed");
  return data.companies;
}

// The v1 company_state cache doesn't know every board row — first-contact
// senders (inbound-only, on the board since 2026-07-11) and freemail keys live
// only in the v2 board. Falling back to board.json keeps "reply" working for
// ANYONE who writes in: the fields the dossier needs are mapped from the
// certified row, and the agent reads the full thread itself anyway.
interface BoardRow {
  key: string; people?: string[]; bucket?: string; state?: string; signals?: string[];
  last_in_date?: string; last_in_from?: string; last_in_subj?: string; last_in_gist?: string;
  last_out_date?: string; last_out_gist?: string; deliverables_missing?: string[];
  key_facts?: Record<string, string[]> | null;
  notes?: { ts?: string; kind?: string; note?: string; by?: string }[];
  // Archivist verdict (truth.py / the v2 fold) — the certified summary and
  // recommended next step for this company, kept fresh independent of the v1
  // company_state cache.
  verdict?: { summary?: string | null; next_action?: string | null; stage_signal?: string | null } | null;
}
function boardCompany(key: string): Company | null {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(VAULT, "state/board.json"), "utf8")) as { companies?: BoardRow[] };
    const c = (b.companies ?? []).find((x) => x.key === key);
    if (!c) return null;
    return {
      domain: c.key, people: c.people ?? [], state: c.state, signals: c.signals ?? [],
      last_in_date: c.last_in_date, last_in_from: c.last_in_from,
      last_in_subj: c.last_in_subj, last_in_text: c.last_in_gist,
      last_out_date: c.last_out_date, last_out_text: c.last_out_gist,
      deliverables: c.deliverables_missing ?? [],
      key_facts: c.key_facts ?? null, notes: c.notes ?? [],
      enrich_summary: c.verdict?.summary ?? null,
      enrich_next: c.verdict?.next_action ?? null,
    };
  } catch { return null; }
}
// v1 (company_state.py --cache-only) is the primary source, but its Archivist
// fields (enrich_summary/enrich_next, fed into the drafting prompt as
// "Archivist summary/suggested next") go stale between v1 regens. board.json's
// verdict is the v2-fed, freshly certified read of the same two facts — so for
// a key present in both, the board's verdict WINS whenever it's non-empty; v1
// still supplies everything board.json doesn't carry (this unblocks freezing
// v1 verdict writes later without staling the drafting context).
async function findCompany(key: string): Promise<Company | null> {
  const v1 = (await loadCompanies().catch(() => [] as Company[])).find((x) => x.domain === key);
  const boarded = boardCompany(key);
  if (!v1) return boarded;
  if (!boarded) return v1;
  return {
    ...v1,
    enrich_summary: boarded.enrich_summary || v1.enrich_summary,
    enrich_next: boarded.enrich_next || v1.enrich_next,
  };
}

function launch(action: string, promptText: string, extraArgs: string[] = []): string {
  fs.mkdirSync(RUNS, { recursive: true });
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const promptFile = path.join(RUNS, `${stamp}-${action}.prompt.md`);
  fs.writeFileSync(promptFile, promptText, "utf8");
  return startJob({ label: `workbench-${action}`, argv: [WB, promptFile, ...extraArgs], cwd: WORKSPACE });
}

interface Body {
  action?: "draft-row" | "draft-day" | "revise" | "revise-group" | "investigate" | "operator-instruct";
  domain?: string;
  key?: string;       // operator-instruct: the company the instruction is scoped to
  domains?: string[]; // draft-day: cold/fresh keys with no board row
  file?: string;      // revise: base pack file name
  entry?: number;     // revise: flat entry index
  instruction?: string;
  attachments?: string[]; // operator's pre-draft asset picks (WORKSPACE-relative)
  suggest?: boolean;      // draft-row: auto-suggest catalog/price-list from their ask (default true; nudges pass false — never push files on a soft follow-up)
}

// ── held-meeting lookup (meetings.json registry) ─────────────────────────────
// A HELD event (created sendUpdates=none, invite not yet fired) whose client
// attendee belongs to this company must ride the reply being drafted: the Meet
// link goes in the body, _meet_event_id binds the event to the pack, and the
// invite still fires only at approved send (/api/send confirmHeldMeetings).
interface HeldMeeting { event_id: string; meet_url: string; when: string; start?: string }
function heldMeetingFor(key: string, people: string[]): HeldMeeting | null {
  let reg: { meetings?: { event_id?: string; meet_url?: string; status?: string; start?: string; tz?: string; attendees?: string[] }[] };
  try { reg = JSON.parse(fs.readFileSync(path.join(VAULT, "pipeline/meetings.json"), "utf8")); } catch { return null; }
  const ppl = new Set(people.map((p) => p.toLowerCase()));
  const hit = (reg.meetings ?? []).filter((m) =>
    m.event_id && m.meet_url
    && (m.status ?? "").toLowerCase().startsWith("held")
    && (m.attendees ?? []).some((a) => {
      const e = (a ?? "").toLowerCase();
      return ppl.has(e) || companyKey(e) === key;
    }),
  ).sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""))[0];
  if (!hit) return null;
  const when = hit.start
    ? new Date(hit.start).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) + (hit.tz ? ` (${hit.tz})` : "")
    : "";
  return { event_id: hit.event_id!, meet_url: hit.meet_url!, when, start: hit.start };
}

// Resolve + validate the extras for a draft run: operator picks (hard-fail on a
// bad path) + keyword auto-suggest + a held meeting. Returns the prompt lines
// and the extras JSON for the deterministic post-run apply.
function buildExtras(opts: { picks: string[]; suggestFrom: string; company: Company | null; key: string; optional: boolean }):
  { error?: string; promptLines: string[]; extras: { attach: string[]; meet?: { event_id: string; url: string; when: string }; optional: boolean } | null } {
  const { ok, bad } = validateAssetPaths(opts.picks);
  if (bad.length) return { error: `these attachments aren't in the asset library: ${bad.join(", ")}`, promptLines: [], extras: null };
  const sugg = opts.suggestFrom ? suggestAttachments(opts.suggestFrom) : { paths: [], labels: [] };
  const attach = [...ok, ...sugg.paths.filter((p) => !ok.includes(p))];
  const meeting = heldMeetingFor(opts.key, opts.company?.people ?? []);
  const promptLines: string[] = [];
  if (attach.length) {
    promptLines.push(
      `FILES ATTACHED TO THIS EMAIL (the system attaches them to the draft — do NOT paste file paths; ` +
      `mention them naturally in the body, e.g. "adjunto encontrará…" / "please find attached…"): ` +
      attach.map((p) => p.split("/").pop()).join(", "),
    );
  }
  if (meeting) {
    promptLines.push(
      `A MEETING TIME IS ALREADY HELD ON OUR CALENDAR for this company: ${meeting.when || "see link"} — Meet link ${meeting.meet_url}. ` +
      `Confirm that time in the reply and include the link where it reads naturally. If you leave the link out, ` +
      `the system inserts it before the sign-off. The calendar invite itself fires only when the operator approves the send.`,
    );
  }
  if (!attach.length && !meeting) return { promptLines: [], extras: null };
  return {
    promptLines,
    extras: { attach, ...(meeting ? { meet: { event_id: meeting.event_id, url: meeting.meet_url, when: meeting.when } } : {}), optional: opts.optional },
  };
}

function writeExtrasFile(extras: NonNullable<ReturnType<typeof buildExtras>["extras"]>): string {
  fs.mkdirSync(RUNS, { recursive: true });
  const f = path.join(RUNS, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-extras.json`);
  fs.writeFileSync(f, JSON.stringify(extras), "utf8");
  return f;
}

// Readable transcript for the instruct prompt — same source as the pane's
// conversation (core/thread_dump.py --key), clipped so the prompt stays sane.
async function threadTranscript(key: string): Promise<string> {
  const r = await run(PY, ["thread_dump.py", "--key", key], { cwd: CORE, timeout: 30_000 });
  try {
    const t = JSON.parse(r.stdout) as { messages?: { date?: string; dir?: string; from?: string; subject?: string; body?: string }[] };
    const msgs = (t.messages ?? []).slice(-40);
    if (msgs.length === 0) return "— no messages on file —";
    return msgs.map((m) =>
      `[${(m.date ?? "").slice(0, 16)}] ${m.dir === "in" ? m.from ?? "them" : "US"} · ${m.subject ?? ""}\n${(m.body ?? "").slice(0, 2000)}`,
    ).join("\n---\n");
  } catch {
    return "— thread unavailable; read the corpus under /opt/velab/vault/inbox yourself —";
  }
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Body;
  const today = new Date().toISOString().slice(0, 10);

  try {
    if (b.action === "draft-row") {
      if (!b.domain) return Response.json({ error: "need domain" }, { status: 400 });
      const g = gatedState(b.domain);
      if (g) return Response.json({ error: gatedMsg(b.domain, g) }, { status: 409 });
      const c = await findCompany(b.domain);
      if (!c) return Response.json({ error: `${b.domain} isn't on the board — reload it and try again` }, { status: 404 });
      const slug = b.domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40);
      const packAbs = path.join(DRAFTS_DIR, `${today}__reply__${slug}.json`);
      const extra = b.instruction?.trim()
        ? `\nOPERATOR'S EXTRA INSTRUCTION (verbatim — follow it over the defaults):\n${b.instruction.trim()}\n`
        : "";
      // operator picks + (unless a nudge) keyword auto-suggest + a held meeting
      const suggestFrom = b.suggest === false ? "" :
        [c.last_in_text, c.ask_gist, ...(c.deliverables ?? [])].filter(Boolean).join("\n");
      const ex = buildExtras({ picks: b.attachments ?? [], suggestFrom, company: c, key: b.domain, optional: false });
      if (ex.error) return Response.json({ error: ex.error }, { status: 400 });
      const prompt = `You are drafting ONE VELAB outbound reply. Work headlessly and finish.

${HOUSE_RULES}

CERTIFIED DOSSIER:
${dossier(c)}
${extra}${ex.promptLines.length ? "\n" + ex.promptLines.join("\n\n") + "\n" : ""}
TASK:
1. If the dossier is not enough, read the full thread: cd /opt/velab/workspace && python3 tools/thread_read.py --email ${(c.people ?? [])[0] ?? b.domain} (or use the corpus under /opt/velab/vault/inbox).
2. Write EXACTLY ONE pack file: ${packAbs}
   Shape: {"date":"${today}","batch_label":"Reply — ${b.domain}","status":"draft","drafts":[{"institution":...,"to_email":...,"to_name":...,"subject":...,"body":...,"draft_type":"REPLY","in_reply_to":null,"_thread":"pending"}]}
   Subject: keep their thread's subject with "Re:" (established reply — do not invent a new subject).
3. The operator asked for this draft, so a draft is the deliverable — even when the inbound
   is junk or hostile. In that case write a brief, neutral, professional non-engaging reply in
   VELAB's voice (never mirror abusive language, never escalate), and add one plain
   ADVICE: line in your output with your recommendation (e.g. "recommend not sending — junk").
   NO_DRAFT is ONLY for mechanical impossibility (no resolvable recipient address):
   NO_DRAFT: <one plain sentence saying why, for the operator>
4. Do not stage, do not send, do not touch any other file. When the pack is written, print DONE and stop.`;
      const extraArgs = ["--expect-pack", packAbs];
      if (ex.extras) extraArgs.push("--apply-extras", packAbs, writeExtrasFile(ex.extras));
      return Response.json({ ok: true, jobId: launch("draft-row", prompt, extraArgs) });
    }

    if (b.action === "draft-day") {
      const decisions = readDecisions(today);
      const decided = Object.entries(decisions).filter(([, d]) => d.decision === "reply" || d.decision === "include").map(([k]) => k);
      const wanted = new Set([...(b.domains ?? []), ...decided].filter((k) => !gatedState(k)));
      if (wanted.size === 0) return Response.json({ error: "nothing decided to draft (paused/closed companies are skipped)" }, { status: 400 });
      const companies = await loadCompanies();
      const rows = companies.filter((c) => wanted.has(c.domain));
      const rowKeys = new Set(rows.map((r) => r.domain));
      const coldKeys = [...wanted].filter((k) => !rowKeys.has(k));
      const prompt = `You are drafting TODAY'S VELAB outbound — the operator triaged the board and decided these items. Work headlessly and finish.

${HOUSE_RULES}

REPLY ITEMS (ground each in its thread; reply in their language):
${rows.map(dossier).join("\n\n────────\n\n") || "none"}

COLD/FRESH ITEMS (templated cold path per the /draft contract; approved cold voice, no false familiarity outside LatAm): ${coldKeys.join(", ") || "none"}

TASK:
1. Classify each item per the drafting contract (commands/draft.md) (only cold is templated).
2. PACK RULE — one company per warm pack (never bundle warm replies):
   • For EACH reply/follow-up item write its OWN pack:
     /opt/velab/vault/pipeline/drafts/${today}__reply__<domain-slug>.json
     Shape: {"date":"${today}","batch_label":"Reply — <domain>","status":"draft","drafts":[<exactly ONE entry>]}
   • Write ALL cold/fresh items into ONE shared batch pack:
     /opt/velab/vault/pipeline/drafts/${today}__cold__day.json (same shape, batch_label "Cold — day batch").
   Entry shape: {"institution","to_email","to_name","subject","body","draft_type","in_reply_to":null,"_thread":"pending"}.
   Established replies keep their thread subject with "Re:".
3. Do not stage, do not send. When the packs are written, print DONE and stop.`;
      return Response.json({ ok: true, jobId: launch("draft-day", prompt), items: wanted.size });
    }

    if (b.action === "revise") {
      if (!b.file || typeof b.entry !== "number" || !b.instruction?.trim()) {
        return Response.json({ error: "need file + entry + instruction" }, { status: 400 });
      }
      const abs = safeUnder(DRAFTS_DIR, b.file);
      if (!abs || !fs.existsSync(abs) || abs.endsWith(".threaded.json") || abs.endsWith(".staged.json")) {
        return Response.json({ error: "bad base pack" }, { status: 400 });
      }
      const pack = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
      const entries = Object.values(pack).filter(Array.isArray).flat() as { to_email?: string; subject?: string; body?: string }[];
      const e = entries[b.entry];
      if (!e) return Response.json({ error: "entry out of range" }, { status: 400 });
      const gr = e.to_email ? gatedState(e.to_email) : null;
      if (gr) return Response.json({ error: gatedMsg(e.to_email ?? "this company", gr) }, { status: 409 });
      fs.mkdirSync(RUNS, { recursive: true });
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const resultFile = path.join(RUNS, `${stamp}-revision.json`);
      const instrFile = path.join(RUNS, `${stamp}-instruction.txt`);
      fs.writeFileSync(instrFile, b.instruction.trim(), "utf8");
      const prompt = `You are revising ONE VELAB draft with the operator, in place. Work headlessly and finish.

${HOUSE_RULES}

CURRENT DRAFT (to ${e.to_email}):
Subject: ${e.subject}
---
${e.body}
---

OPERATOR'S REVISION INSTRUCTION (verbatim):
${b.instruction.trim()}

TASK:
1. Apply the instruction faithfully. If it requires thread context, read the corpus under
   /opt/velab/vault/inbox or run: cd /opt/velab/workspace && python3 tools/thread_read.py --email ${e.to_email}
2. Write EXACTLY ONE file: ${resultFile}
   {"subject": "<final subject>", "body": "<final body>", "summary": "<one sentence: what you changed and why>"}
   Keep the subject unchanged unless the instruction explicitly asks to change it (threading anchor).
3. Do NOT edit the pack yourself — the apply step is deterministic. Print DONE and stop.`;
      const jobId = launch("revise", prompt, ["--apply-revision", abs, String(b.entry), resultFile, instrFile]);
      return Response.json({ ok: true, jobId });
    }

    if (b.action === "revise-group") {
      if (!b.file || !b.instruction?.trim()) {
        return Response.json({ error: "need file + instruction" }, { status: 400 });
      }
      // one-template guarantee holds ONLY for the single-variant cold packs
      // (gen_cold_pack.py --lang --step). Anything else is per-thread material —
      // server-side refusal, plain words (doctrine tenet 23).
      const m = b.file.match(/__cold-followups__(english|spanish)__cold-0[23]\.json$/);
      if (!m) {
        return Response.json({ error: "Only a cold follow-up group shares one email — rewrite other drafts one at a time." }, { status: 400 });
      }
      const lang = m[1];
      const abs = safeUnder(DRAFTS_DIR, b.file);
      if (!abs || !fs.existsSync(abs) || abs.endsWith(".threaded.json") || abs.endsWith(".staged.json")) {
        return Response.json({ error: "bad base pack" }, { status: 400 });
      }
      const pack = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
      const entries = Object.values(pack).filter(Array.isArray).flat() as { institution?: string; subject?: string; body?: string }[];
      const sample = entries[0];
      if (!sample?.body || !sample.institution?.trim()) {
        return Response.json({ error: "that group has no drafts to rewrite" }, { status: 400 });
      }
      // the shared template = the sample body with its own company name lifted
      // back out into the merge slot (the generator's invariant in reverse)
      const inst = sample.institution.trim();
      const template = sample.body.split(inst).join("{institution}");
      fs.mkdirSync(RUNS, { recursive: true });
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const resultFile = path.join(RUNS, `${stamp}-revision.json`);
      const instrFile = path.join(RUNS, `${stamp}-instruction.txt`);
      fs.writeFileSync(instrFile, b.instruction.trim(), "utf8");
      const prompt = `You are revising the ONE shared email of a VELAB cold follow-up group (${entries.length} recipients), with the operator. Work headlessly and finish.

${HOUSE_RULES}

COLD VOICE RULES (this is templated cold outreach, not a warm reply):
- The email's language is ${lang === "spanish" ? "Spanish — write native Spanish, never a translation from English" : "English"} and MUST stay that language.
- No false familiarity: never claim a relationship or conversation that hasn't happened.
- ONE soft ask, no pressure language, no finality language ("last attempt", "closing the file").

CURRENT SHARED EMAIL — {institution} marks where each company's own name goes:
---
${template}
---

OPERATOR'S REVISION INSTRUCTION (verbatim — applies to the whole group):
${b.instruction.trim()}

TASK:
1. Apply the instruction faithfully to the shared body.
2. Keep the literal placeholder {institution} wherever the company's name belongs — at
   minimum in the greeting. Every one of the ${entries.length} drafts is rendered from your body
   by substituting the placeholder; nothing else varies.
3. Subjects are NOT yours to change: each recipient keeps their own conversation's subject.
4. Write EXACTLY ONE file: ${resultFile}
   {"body": "<final shared body, with {institution}>", "summary": "<one sentence: what you changed and why>"}
5. Do NOT edit the pack yourself — the apply step is deterministic. Print DONE and stop.`;
      const jobId = launch("revise-group", prompt, ["--apply-revision", abs, "all", resultFile, instrFile]);
      return Response.json({ ok: true, jobId, count: entries.length });
    }

    if (b.action === "investigate") {
      if (!b.domain) return Response.json({ error: "need domain" }, { status: 400 });
      const c = await findCompany(b.domain);
      if (!c) return Response.json({ error: `${b.domain} isn't on the board — reload it and try again` }, { status: 404 });
      const prompt = `You are INVESTIGATING missing info before VELAB replies to this company. Work headlessly and finish.

${HOUSE_RULES}

CERTIFIED DOSSIER:
${dossier(c)}

TASK:
1. Read the company's full thread(s): cd /opt/velab/workspace && python3 tools/thread_read.py --email ${(c.people ?? [])[0] ?? b.domain} (and the corpus under /opt/velab/vault/inbox if needed).
2. Identify the load-bearing facts we're missing to answer their last ask (models, quantities, prices quoted, commitments, dates, docs already sent).
3. Record EACH fact durably: cd /opt/velab/workspace && python3 tools/lead_note.py --domain ${b.domain} --kind <doc-sent|commitment|figure|preference|note> --note "<the fact, one sentence, dated context included>" --by agent
4. Do not draft, stage, or send anything. When the facts are recorded, print DONE and stop.`;
      return Response.json({ ok: true, jobId: launch("investigate", prompt) });
    }

    if (b.action === "operator-instruct") {
      const key = (b.key ?? b.domain ?? "").trim().toLowerCase();
      const instruction = b.instruction?.trim() ?? "";
      if (!key || !KEY_RX.test(key)) return Response.json({ error: "need a company" }, { status: 400 });
      if (!instruction) return Response.json({ error: "need an instruction" }, { status: 400 });
      const g = gatedState(key);
      if (g) return Response.json({ error: gatedMsg(key, g) }, { status: 409 });
      const c = await findCompany(key);
      const slug = key.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40);
      const transcript = await threadTranscript(key);
      // operator picks + what the INSTRUCTION itself asks to attach ("attach the
      // price list and the catalog") + a held meeting — applied deterministically
      // if the run produces a pack; an answer/directive outcome skips it quietly.
      const ex = buildExtras({ picks: b.attachments ?? [], suggestFrom: instruction, company: c, key, optional: true });
      if (ex.error) return Response.json({ error: ex.error }, { status: 400 });
      const prompt = `You are the VELAB cockpit agent, carrying out ONE operator instruction scoped to ONE company. Work headlessly and finish.

${HOUSE_RULES}

COMPANY: ${key}

CERTIFIED DOSSIER:
${c ? dossier(c) : "— none on file for this key —"}

FULL CONVERSATION (oldest first, from the same corpus the board reads):
${transcript}

CONTEXT IS PRELOADED: the dossier and conversation above are the complete,
current record for ${key} — work from them directly and answer/draft NOW.
Do not re-read the corpus, run thread tools, or explore files unless the
instruction itself demands a fact that is genuinely not above. Speed is part
of the contract: the operator is waiting at the console.
${ex.promptLines.length ? "\n" + ex.promptLines.join("\n\n") + "\n" : ""}
OPERATOR'S INSTRUCTION (verbatim — this is the task):
${instruction}

RESULT CONTRACT — your LAST printed line must be EXACTLY ONE of:
  OPERATOR_RESULT {"type":"draft","pack":"<pack file name>"}
    → you wrote a draft (see rule 1). The cockpit shows it as the normal review card.
  OPERATOR_RESULT {"type":"directive","action":"hold","until":"YYYY-MM-DD","reason":"<one sentence>"}
  OPERATOR_RESULT {"type":"directive","action":"personal","reason":"<one sentence>"}
    → the right move is pausing until a date, or handing the deal to the operator.
      PROPOSE it only — the operator confirms before anything is written.
  OPERATOR_RESULT {"type":"answer","text":"<plain-language answer, grounded in the thread>"}
    → the instruction was a question or analysis. No files written.

RULES:
1. If the instruction calls for outbound text, write EXACTLY ONE pack file:
   /opt/velab/vault/pipeline/drafts/${today}__reply__${slug}.json
   Shape: {"date":"${today}","batch_label":"Reply — ${key}","status":"draft","drafts":[<exactly ONE entry>]}
   Entry shape: {"institution","to_email","to_name","subject","body","draft_type":"REPLY","in_reply_to":null,"_thread":"pending"}.
   PACK RULE — one company per warm pack, exactly one entry, this company only.
   Established replies keep their thread's subject with "Re:".
2. MEETINGS: if the instruction asks to propose or confirm a meeting time, HOLD it on
   the calendar yourself (this is the one registry write the operator's click covers):
   cd /opt/velab/workspace && python3 tools/create_meeting.py --json create \\
     --summary "VELAB × ${key}" --start <YYYY-MM-DDTHH:MM:SS local> --tz America/Chicago \\
     --duration-min 30 --attendees <client-email>,sales@example.com
   Holding notifies NOBODY (sendUpdates=none) — the invite fires only when the operator
   approves the send. Put the returned meet_url in the draft body where it reads naturally
   and add "_meet_event_id": "<event id>" to the entry. NEVER run confirm or cancel.
3. NEVER stage, NEVER send, NEVER edit registries beyond rule 2's calendar hold
   (operator-directives.json included), packs of other companies, or anything outside
   rule 1's file. Durable facts you uncover may be recorded with:
   cd /opt/velab/workspace && python3 tools/lead_note.py --domain ${key} --kind note --note "<fact>" --by agent
4. Print the OPERATOR_RESULT line and stop.`;
      const packAbs = path.join(DRAFTS_DIR, `${today}__reply__${slug}.json`);
      const extraArgs = ex.extras ? ["--apply-extras", packAbs, writeExtrasFile(ex.extras)] : [];
      return Response.json({ ok: true, jobId: launch("operator-instruct", prompt, extraArgs) });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
