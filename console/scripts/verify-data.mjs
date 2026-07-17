#!/usr/bin/env node
// verify-data — COCKPIT-V4 §11.4 data-honesty assertions against a RUNNING
// console (live or COCKPIT_FIXTURES=1). Usage:
//   node scripts/verify-data.mjs [baseUrl]     default http://127.0.0.1:4760
const BASE = process.argv[2] ?? process.env.COCKPIT_URL ?? "http://127.0.0.1:4760";

let failures = 0;
const ok = (name) => console.log(`✓ ${name}`);
const fail = (name, detail) => { console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); failures++; };
const assert = (cond, name, detail) => (cond ? ok(name) : fail(name, detail));

const board = await fetch(`${BASE}/api/board`).then((r) => r.json());
const drafts = await fetch(`${BASE}/api/drafts`).then((r) => r.json());
const view = board.view;

// ── route whitelist: every V4.1 field actually arrives (silent-drop guard)
assert("regenerated" in board && "regenReason" in board, "board route serves regenerated/regenReason");
assert(view.sections.some((s) => s.id === "closeout"), "closeout section present in view");
// V4.2 — operator-directive sections arrive from the engine (never re-derived)
for (const id of ["personal", "held"]) {
  assert(view.sections.some((s) => s.id === id), `${id} section present in view`);
}
const heldRows = view.sections.find((s) => s.id === "held")?.rows ?? [];
assert(heldRows.every((r) => r.meta?.hold_until), "every held row carries its return date (meta.hold_until)");
const closeItems = view.proposed_closes?.items ?? [];
assert(closeItems.every((i) => !i.key || "whose_turn" in i), "close items carry structured fields (whose_turn)",
  JSON.stringify(closeItems[0] ?? {}).slice(0, 120));
const anyRow = view.sections.flatMap((s) => s.rows)[0];
assert(anyRow && "meeting_source" in anyRow.meta, "rows carry meeting_source");

// ── sections are a DISJOINT partition (the dual-state audit bug)
const seen = new Map();
let dual = [];
for (const s of view.sections) for (const r of s.rows) {
  if (seen.has(r.key)) dual.push(`${r.key} in ${seen.get(r.key)}+${s.id}`);
  seen.set(r.key, s.id);
}
assert(dual.length === 0, "no company in two sections", dual.join(", "));

// ── classification counters = section rows (count-equals-group tenet).
// The pipeline funnel is gone (operator ruling); counters derive from the same
// section arrays the rail renders, so equality is structural — assert the
// sections themselves are well-formed and journeys stay consistent with drafts.
const journeyStaged = Object.entries(board.journeys).filter(([, x]) => x.staged).map(([k]) => k);
const stagedPackKeys = new Set((drafts.packs ?? []).filter((p) => p.staged).flatMap((p) => p.recipients ?? []).map((r) => r.toLowerCase()));
assert(journeyStaged.length === 0 || stagedPackKeys.size > 0,
  "staged journeys are backed by staged packs");

// ── frozen registry completeness: every frozen company renders a row
assert((view.frozen_rows?.length ?? 0) >= (view.counts?.frozen ?? 0),
  `frozen rows (${view.frozen_rows?.length}) cover frozen count (${view.counts?.frozen})`);

// ── Pipeline tab (2026-07-12): the ladder partitions are complete + disjoint
const coldRows = view.cold_rows ?? {};
assert(Array.isArray(coldRows.not_due), "engine ships not-yet-due cold rows (cold_rows.not_due)");
const ladderKeys = ["due", "not_due", "exhausted"].flatMap((k) => (coldRows[k] ?? []).map((r) => r.key));
assert(new Set(ladderKeys).size === ladderKeys.length, "no cold company in two ladder states");
assert((coldRows.not_due ?? []).length === (view.counts?.cold_not_due ?? 0),
  `not-due rows (${(coldRows.not_due ?? []).length}) equal the not-due count (${view.counts?.cold_not_due})`);
// every operator-paused row carries its registry story (date at minimum) —
// the Pipeline tab's resurfacing decision depends on it
const pausedRows = (view.frozen_rows ?? []).filter((r) => r.meta?.suppressed === "frozen");
assert(pausedRows.every((r) => r.meta?.frozen_meta?.frozen_on),
  "every paused row carries frozen_meta.frozen_on",
  pausedRows.filter((r) => !r.meta?.frozen_meta?.frozen_on).map((r) => r.key).slice(0, 5).join(", "));

// ── staged truth: one marker per staged pack; warm staged packs are one company
const staged = (drafts.packs ?? []).filter((p) => p.staged && !p.sent);
const multiWarm = staged.filter((p) => p.count > 1 && !(p.types ?? []).every((t) => /^COLD/i.test(t)));
assert(multiWarm.length === 0, "no multi-company warm pack is staged", multiWarm.map((p) => p.file).join(", "));
assert(staged.every((p) => p.stagedAt), "every staged pack has a real marker timestamp (no heuristic)");

console.log(failures ? `\nverify-data: ${failures} FAILURE(S)` : "\nverify-data: all checks passed");
process.exit(failures ? 1 : 0);
