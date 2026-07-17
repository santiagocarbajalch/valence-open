# Cockpit v4 — Ground-up redesign blueprint

**Basis.** The operator's itemized UI audit of 2026-07-04 (~60 verdicts, section by
section), cross-verified against the live code the same day. Three flagged defects were
confirmed as real code-level problems (§1). The remaining verdicts collapse into seven
root causes (§0.3). This blueprint merges that legibility/orientation layer with the two
existing plan docs — `COCKPIT-V3.md` (capability decks) and
`COCKPIT-V3.1-CADENCE-SECTIONS.md` (cadence truth + state sections) — into ONE build
plan. This document supersedes neither: v3/v3.1 mechanics are incorporated by reference
with v4 deltas noted (§8, §9).

**Status: BLUEPRINT.** Nothing here is built. Every file path and line anchor was
verified against the live tree on 2026-07-04.

---

## 0. Charter

### 0.1 Audience ruling (operator, 2026-07-04)

> "Someone familiar with the workflow, with clear action labels, no console speak, and
> well tested features that ensure all content is visible and works as designed."

Interpretation, binding on every spec below:
- **Workflow vocabulary stays** — nudge, cold touch, freeze, stage, thread are fine.
- **Console/system vocabulary goes** — Certified, Archivist, board truth,
  cadence-exhausted, ball theirs, 3bd, (count only), and any string that names internal
  machinery survives only in the System drawer (ADVANCED surface) and tooltips.
- **No first-run onboarding tour.** Orientation is achieved by labels, hints, and a
  legend — not a walkthrough.
- **"Well tested" is a deliverable, not a wish**: §11 defines a verification suite that
  asserts visibility (nothing crushed/clipped/zero-height), contrast floors, copy
  compliance, and e2e behavior. A phase is DONE when its §11 assertions pass, not when
  it renders once.

### 0.2 What stays sacred (unchanged from v2/v3)

- ONE worklist under ONE pipeline bar. The funnel SHAPE stays (operator choice
  2026-07-04: "fix the funnel, keep the shape").
- The send gate: verbatim operator approval, recipient-scoped single-use grants,
  DARK/LIVE switch, 50/day cap, 65s pace. Never weakened, never pre-filled.
- LLM baked into features; **no sidecar chat**.
- Truth engine v2 owns triage; the console never re-classifies.
- House-format pipeline renders every outbound; staged Gmail drafts are twins.

### 0.3 The seven root causes (what the ~60 audit verdicts collapse into)

| # | Root cause | Audit items it explains |
|---|---|---|
| RC1 | **Verbatim-parity rule leaks machine prose into the chrome** | cadence-exhausted, ball theirs, 3bd, (count only), COLD worklist run-on, truncated close reasoning, mixed-language pill |
| RC2 | **No orientation layer** | sr-only page title, jargon tabs, unexplained Certified, no dot legend, date without "today" |
| RC3 | **Semantic collapse of the visual language** | one pill shape = status+tag+note, muted-grey overuse, unlegended color code, emoji bullets |
| RC4 | **Visual weight inverted from workflow & safety** | Stage loudest / Edit+Revise faintest, "7 need a reply" smallest header number, Next-step chip looks disabled |
| RC5 | **Layout geometry** | three scroll regions, crushed/invisible mail history, no history→guidance→action delineation |
| RC6 | **Ambiguity hotspots** | "Close…", "Skip today", "Sending live", gear-that-isn't-settings, "+ Leads", three refresh affordances |
| RC7 | **Data-semantics dishonesty** | Staged 0 vs Drafts·8, Arrived 18→Decided 0→Drafted 16 |

### 0.4 THE AMENDED PARITY RULE (replaces the v2 "verbatim strings" rule)

Old rule: *every classification and recommendation string renders VERBATIM from the
canonical view.* That rule caused RC1 directly.

**New rule — parity on facts, not on prose:**
1. The engine (`core/truth.py` → `board.json`) emits **structured fields** — enums,
   counts, dates, keys — never display sentences (except inside the System drawer's raw
   view).
2. The console owns every human sentence, generated in exactly ONE module:
   `src/components/cockpit/prose.ts` (§6.5). One place to write copy, one place to test
   it, one place the copy-lint runs against.
3. The certifier keeps parity **on the structured fields** (counts, bucket membership,
   enums) — parity is unweakened; only the rendering layer moved.
4. `/inbox-check`'s terminal renderer may keep its own prose; board.json is the shared
   truth, prose is per-surface.

---

## 1. Verified defects (fix regardless of any other choice)

### D1 — "Drafts · 8 staged" vs pipeline "Staged 0" (RC7)

- Header chip: `CockpitView.tsx:222` — `packs.filter(p => p.staged && !p.sent).length`
  = **pack files** with a `.staged.json` marker, any date, any recipient.
- Pipeline chip: `CockpitView.tsx:123` — **today's board keys** whose journey is staged.
- Both correct, different unit AND window, zero disambiguation on screen.

**Fix:** rename + rescope the header chip (§4.6): `Gmail Drafts · 8 waiting to send`
(pack scope, any date) with tooltip; funnel "Staged" stays today-company-scoped. Add the
§11.4 consistency test that renders both from one fixture and asserts the labels differ.

### D2 — Arrived 18 → Decided 0 → Drafted 16 (RC7)

- `Decided` counts only today's decisions (`src/lib/pipeline.ts:48`,
  `r.ts.startsWith(today)`).
- `Drafted`/`Staged` count pack artifacts from ANY day (latest pack wins, no date scope).
- `Sent` = today within a 3-day file window.

Three time windows in one funnel → non-monotonic garbage.

**Fix — monotonic funnel invariant** (§4.3): a draft/staged/sent artifact **implies a
decision**. `decided(k) = hasTodayDecision(k) || journey(k).drafted != null`. This
enforces `Arrived ≥ Decided ≥ Drafted ≥ Staged` by construction while keeping the
five-stage shape. `Sent` stays today-scoped. A dev-mode assertion logs any violation;
§11.4 tests the invariant on fixtures.

### D3 — Mail history crushed to invisibility (RC5; operator follow-up 2026-07-04)

`ThreadPane.tsx:201` — the decision-support footer is `shrink-0` and contains notes +
next-step + AI box + the **entire DraftCard** (full email body, edit, revision strip).
With a draft present, the footer consumes most of the pane; the conversation
(`flex-1 min-h-0`, line 164) is left a sliver with no expand, no splitter, no collapse.

**Fix:** the right pane becomes ONE scroll column with three labeled zones and a pinned
one-line jump bar (§6.1). The draft physically cannot crush the history because it lives
*in the scroll flow*, not in a fixed footer. §11.2 asserts the conversation region gets
≥ 40% of pane height with a draft present (before scrolling).

---

## 2. Vocabulary — the complete rename table

Every string below is FINAL copy. Copy-lint (§11.5) bans the left column from `src/`
(components; the System drawer raw view is exempt).

| Today | v4 | Where |
|---|---|---|
| Cockpit (tab) | **Today** | nav tab; the page answers "what needs me today" |
| (sr-only subtitle) | **Visible header line: "Inbox board — who needs a reply, and what we send."** | under the tab bar, `text-caption text-ink-dim`, one line |
| Sat, Jul 4 | **Today · Sat, Jul 4** | TopBar |
| 7 need a reply | **7 NEED A REPLY** (promoted, §4.2) | TopBar |
| Filter | **Show:** | funnel label |
| Certified / Not certified | **Data checked ✓ / ⚠ Data check failed** + tooltip "Every count was re-verified against the mailbox at HH:MM." | TopBar pill → System drawer |
| Sending live | **Sending: LIVE** pill (green) / **Sending: OFF** (grey) / **Sending: PAUSED** (red) + tooltip "LIVE = approved sends go out for real, max 50/day, 65s apart." | TopBar |
| Drafts · 8 staged | **Gmail Drafts · 8 waiting** + tooltip "Staged draft packs not yet sent — includes earlier days and cold batches. Not the same as today's Staged filter." | TopBar |
| + Leads | **Add leads** | TopBar |
| gear icon (email format) | **envelope icon**, label "Email format" | TopBar |
| New mail banner + refresh icon | ONE control (§4.7) | TopBar |
| Skip today | **Set aside until tomorrow** | ThreadPane header |
| Suggested closes | **Suggested close-outs — the engine thinks these leads are dead** | left-rail footer |
| Close… | **Close out…** (modal copy already correct: "marks the lead declined") | left-rail footer |
| 🔴 COLD worklist — 2 genuinely due · 237 cadence-exhausted (→ freeze proposals, not nudged) · 22 not yet due | structured Cold block (§5.4) | left-rail footer |
| 🧊 Frozen: 13 (count only) · system status → | **13 paused by you · System status →** (real link styling) | left-rail footer |
| ball theirs | **their move** (prose.ts renders from `whose_turn` enum) | close-out reasoning |
| 3bd / Nbd | **N business days** (always spelled out) | everywhere |
| quiet 5d | **quiet 5 days** | row status |
| Archivist — advisory, not board truth | **AI suggestion — advisory; the engine's Next step above is what's authoritative** | guidance zone |
| written before the latest mail, treat as out of date | stale advisories COLLAPSE (§6.4) — copy: **"An earlier AI note predates the latest mail — show it anyway"** | guidance zone |
| Warm licitacion reply | **Warm reply — licitación** (TypeTag, accent-correct; taxonomy in labels.ts gets a `display` field with correct diacritics) | draft card |
| ✎ Edit by hand (faint text) | **Edit** — real secondary button (§3.4) | draft card |
| meeting in limbo — old date void, new one pending | **rescheduling — old date cancelled, waiting on a new one** | meetings strip / status |
| touch 2 of 3 due | **cold touch 2 of 3 due** | cold rows |

Tab bar (all five): **Today · Workspace · Files · Chat · Health** → rename `Health` →
**System**. Active tab: `aria-current` + accent underline bar 2px + full-ink text
(inactive = ink-dim), not a subtle pill fill (§3.5).

---

## 3. The visual language system (RC3, RC4)

### 3.1 Pill taxonomy — one shape per meaning

Split `kit` `Pill` into three components (`src/components/kit/core.tsx`):

| Component | Meaning | Shape spec | Example |
|---|---|---|---|
| `StatusPill` | current STATE of an item | `rounded-full`, tone/12 fill, tone/45 border, tone-ink text, lowercase body text | `needs reply`, `meeting set`, `staged ✓` |
| `TypeTag` | classification/taxonomy | `rounded-ctl` (squared), NO fill, line border, `text-micro` UPPERCASE tracking-wide, ink-dim | `WARM REPLY — LICITACIÓN`, `COLD TOUCH 2/3` |
| `NoteChip` | operator annotation marker | accent color, pen glyph + count, `rounded-ctl`, accent/40 border | `✎ 1 note` |

Migration: every current `Pill`/hand-rolled pill call site is reassigned to exactly one
class (BoardList notes → NoteChip; row status words → StatusPill; draft-type →
TypeTag; "Not staged" → StatusPill tone=warn). `Pill` itself is deleted after migration
so no new ambiguous pills can appear.

### 3.2 Ink hierarchy rules (enforced, not vibes)

1. Content that carries a decision (reasoning, status, counts, recommendations) renders
   at `ink` or `ink-dim` — **never `ink-faint`**.
2. `ink-faint` is reserved for: decorative glyphs, empty-state text, timestamps inside
   already-secondary blocks.
3. Max ONE step of de-emphasis per block: if the block heading is ink-dim, its body may
   not drop to ink-faint.
4. Interactive controls (chevrons, links, icon buttons) render at minimum `ink-dim`,
   `ink` on hover — never ink-faint (the audit's invisible chevrons/toggle).
5. Contrast floor: body text ≥ 4.5:1 against its actual background, large/bold ≥ 3:1 —
   asserted by axe in §11.3. Current `--ink-faint: #8d98ab` on `#0…` field passes AA for
   large only → any ink-faint usage at `text-body` size is a lint error (§11.5 greps
   for `text-body.*ink-faint` co-occurrence).

### 3.3 The dot legend (RC2, RC3)

Colors keep their tone semantics, now DOCUMENTED in the UI:

- ● pink (`bad`) — an answer is owed now
- ● amber (`warn`) — attention/deadline (follow-up window passed, invite not sent)
- ● blue (`info`) — informational lane (bid desk, added today)
- ● grey (`dim`) — waiting, no action needed
- ● green (`ok`) — confirmed done

Surface: a `Legend` popover, opened from a small `● What the colors mean` link pinned at
the bottom of the left rail (above the footer facts). Every `Dot` also gets a `title`
(component already supports it — stop passing `decorative` where meaning exists).
No emoji bullets anywhere (🔴/🧊 die with the footer rewrite, §5.4).

### 3.4 Button weight ladder (RC4)

Weight follows **the recommended next action for the item**, and destructive is never
loudest:

1. **Primary (accent fill)** — exactly ONE per pane: the current next step. Undrafted →
   `✦ Draft the reply`. Drafted-unstaged → `Stage to Gmail Drafts`. Staged → `Send…`
   (opens SendModal). The primary MOVES as the item advances; two filled buttons in one
   pane is a §11 test failure.
2. **Secondary (outline, full-ink text)** — real alternatives: `Edit`, `Revise`,
   `Schedule meeting`, `Set aside until tomorrow`.
3. **Tertiary (text, ink-dim)** — navigation/expanders: `Why this suggestion?`,
   zone jump links.
4. **Danger (outline tone-bad)** — `Close out…`, `Do not contact` — outline only, never
   filled, always behind a confirm modal (already true).

`Revise` specifically: renders as secondary; becomes accent-filled ONLY when its input
has text (it is then the imminent action). Never the muted olive "looks disabled" fill.

### 3.5 Header/nav affordances

- Active tab: 2px accent underline + full-ink text (see §2).
- Funnel chips: ALL five get the identical interactive treatment — border on hover,
  `aria-pressed` ring when selected (today only "Arrived" reads selected because `all`
  is default-on; the ring style must be visually identical across chips).
- Theme toggle: keep position, raise contrast to ink-dim floor, add visible focus ring.
- The `◇` logo glyph: render at tone-info-ink instead of faint (brand mark, not
  artifact) — or drop the glyph; either passes.

---

## 4. TopBar spec (final layout, left → right)

```
[7 NEED A REPLY]  Today · Sat, Jul 4   Show: [Arrived 18 → Decided 16 → Drafted 16 → Staged 0 → Sent 0]
      …spacer…  0/50 sent today · [Sending: LIVE]  [Data checked ✓] [✦ Draft the day (3)] [Gmail Drafts · 8 waiting] [Add leads] [✉] [⟳]
```

### 4.1 One row, two clusters
Left cluster = orientation + filter. Right cluster = day meters + actions. Below the
bar: the one-line purpose caption (§2). Wraps to two rows under 1100px with the purpose
line hidden.

### 4.2 The owed count is the loudest element
`7 NEED A REPLY` — `text-title font-semibold text-tone-bad-ink`, leftmost, click =
scrolls left rail to Reply now + expands it. Zero state: `NOTHING OWED ✓` in
tone-ok-ink at the same size (the good news deserves the same prominence).

### 4.3 Funnel semantics (D2 fix — same shape, one window)
All five chips scope to **today's board items** (`allItems`):
```ts
decided(k) = !!board.decisions[k] || !!board.journeys[k]?.drafted   // artifact implies decision
drafted(k) = !!board.journeys[k]?.drafted
staged(k)  = !!board.journeys[k]?.staged
sent(k)    = board.journeys[k]?.sent?.startsWith(today)
```
Invariant `arrived ≥ decided ≥ drafted ≥ staged` holds by construction; dev-mode
`console.assert` + fixture test (§11.4). Chip hint tooltips keep the STAGE_HINT
sentences (already good). Zero counts render the number at ink-faint inside the chip
(allowed: it's inside an interactive control at caption size, exempt per §3.2 rule 2
review — the CHIP label stays ink-dim).

### 4.4 Sending status pill — see §2 copy. Click → System drawer.
### 4.5 Data-check pill — see §2 copy. Click → System drawer. Failure state keeps the
red banner below the bar (existing `role=alert` block, copy unchanged — it's good).
### 4.6 Gmail Drafts chip — see §2/D1. Click → packs drawer (unchanged behavior).
### 4.7 ONE refresh affordance (RC6)
Delete the full-width amber banner. The refresh icon-button is the single control; when
`newMail` is true it expands into a labeled amber button: `● New mail — refresh`
(auto-width, same slot). The 30s mtime poll behavior is unchanged. Rationale: the audit
counted three competing refresh affordances; this leaves one, in a fixed location, that
gets louder exactly when it matters.

---

## 5. Left rail spec

### 5.1 Section set (merges v3.1 §5 into the current GROUPS)

Order and membership (exclusive, spine order preserved):

1. **Meetings** strip (unchanged position; buttons get hover underline + chevron so they
   read as clickable — audit item)
2. **Reply now** — tone bad — "They wrote last — an answer is owed."
3. **Needs a look** — tone bad — "They replied, but the engine can't tell what they want
   — read it yourself." (splits out of Reply now per v3.1; membership =
   `state === "replied-unclassified"`)
4. **Gone quiet** — tone warn — hint shortened: "Our turn — the follow-up window
   passed." (the parenthetical rule moves to a tooltip on the hint)
5. **Waiting on them** — tone dim — collapsed by default
6. **Cold outreach due** — tone warn — collapsed
7. **Cooling** *(new, v3.1 §4.3)* — tone dim — collapsed, slim rows, no draft actions —
   "We just sent — nothing to do until the cadence clock runs." Rows carry the
   CadenceChip countdown (`due in 2 business days · Thu Jul 9`).
8. **Bid desk (public sector)** — tone info — collapsed
9. **Added today** — tone info — collapsed

Section headers: label + count at `text-body font-medium ink`; chevron at ink-dim
(§3.2 rule 4); hint caption stays visible when open (pattern the audit praised —
"more sections should do exactly this").

### 5.2 Row spec (unchanged shape, reclassed chips)
`primary` company · `secondary` contact · right-aligned `StatusPill` (was raw colored
word) · `NoteChip` when notes exist. Selected row: `bg-fill-3` PLUS a 2px accent left
bar (the audit called the current fill "subtle"; the bar makes selection unmistakable).

### 5.3 Cadence truth (v3.1 Part A, folded)
Engine emits per-row `cadence: {clock, phase, due_in_bizdays, due_on}` (v3.1 §4.1
verbatim — constants live in `core/cadence.py`, imported everywhere, never re-derived).
UI renders CadenceChip via prose.ts: `due in N business days`, `due today`, `overdue N
business days`. Journey strip gains `SENT → COOLING (due Thu Jul 9)`.

### 5.4 The footer facts become a structured Cold block (RC1's worst offender)

Engine change: `view.cold_line` (prose) → `view.cold_tally = {due, not_yet, exhausted}`
+ keep `frozen_count`. Render:

```
COLD OUTREACH
  2   due for their next touch            → expands the Cold section
  22  scheduled for later
  237 finished the ladder — close-out suggestions only, never nudged again

SUGGESTED CLOSE-OUTS — the engine thinks these leads are dead
  northlake-university.example.com · their move — the staff reply set an explicit condition
  [show reasoning ∨]                                   [Close out…]

13 paused by you · System status →
```

- Counts at `font-mono ink`, labels at ink-dim `text-body` (NOT caption — this block
  failed the audit at caption/faint).
- Close-out reasoning: **never truncated**. One-line clamp + `show reasoning` expands
  IN PLACE (§7 truncation policy). The reasoning sentence is rendered by prose.ts from
  structured fields (`whose_turn`, `reason_kind`, `evidence_quote`) — the evidence quote
  from the thread renders verbatim *as a quote*, attributed, because it's content, not
  chrome.
- `Close out…` button: Danger class (§3.4). Modal unchanged.

### 5.5 Legend link (§3.3) sits between the sections and the Cold block.

---

## 6. Right pane spec (D3 fix + RC5)

### 6.1 Geometry — one scroll column, three labeled zones, one pinned jump bar

```
┌─ pane header (sticky in pane): company · people · meeting line · actions ─┐
│  ═ CONVERSATION ═══════════════════════════════ 14 messages · Jun 2 – Jul 3
│    [message bubbles, oldest first, auto-scrolled to latest]
│  ═ GUIDANCE ═══════════════════════════════════
│    [operator notes] [NEXT STEP card] [AI suggestion]
│  ═ YOUR REPLY ═════════════════════════════════
│    [draft card | ✦ Draft the reply]
├───────────────────────────────────────────────────────────────────────────┤
│ ▸ Draft ready — not staged · To maria@acme-labs.example.com    [Jump to reply ↓]│  ← pinned bar
└───────────────────────────────────────────────────────────────────────────┘
```

- The pane is `flex flex-col`; header `shrink-0`; the three zones live in ONE
  `flex-1 min-h-0 overflow-y-auto` scroller; the jump bar is `shrink-0`, exactly one
  line, always visible.
- Zone headers: `text-micro uppercase tracking-wide ink-dim` with a hairline rule —
  the delineation the audit demanded between history / recommendation / action.
- **The draft cannot crush the history** — it's in the flow. Initial scroll lands at
  the latest message (existing behavior). The pinned bar always tells you the reply
  state and jumps to it; while inside YOUR REPLY, the bar flips to `↑ Back to the
  conversation`. (IntersectionObserver on the zone sentinels.)
- **Page scroll dies**: the cockpit route locks the outer page (`h-screen`,
  `overflow-hidden` on the page wrapper) so exactly TWO scroll regions exist — left
  rail, right column. §11.2 asserts `document.scrollingElement` has no overflow on
  this route.

### 6.2 Pane header
Actions per §3.4: `Schedule meeting` + `Set aside until tomorrow` (secondary), kebab
menu unchanged (freeze/close-out/DNC with existing labels + confirm modals).

### 6.3 GUIDANCE zone — Next step is promoted (audit §10)
Order (authority) stays: operator notes → engine → AI. Changes:
- **NEXT STEP card**: accent-left-bordered card (same treatment as operator notes but
  tone-neutral), label `NEXT STEP`, body = full sentence from prose.ts
  (`nudge or freeze (3bd quiet)` → "Nudge them, or freeze the lead — they've been quiet
  3 business days."). It is a card, not a grey chip; it can no longer read as disabled.
- Warning-prefixed engine parts keep the warn treatment.

### 6.4 AI suggestion box (audit §11)
- Fresh advisory: render the FULL `next_action` text by default (no mid-sentence
  truncation — kill the short/long dance at `ThreadPane.tsx:83`). `Why this
  suggestion?` keeps the context expander.
- **Stale advisory: collapsed to one tertiary line** — "An earlier AI note predates the
  latest mail — show it anyway". Click expands with a `STALE` TypeTag. The current
  behavior (prominently rendering advice while calling it out-of-date) is
  self-undermining; stale advice must opt-in.
- Label copy per §2.

### 6.5 `prose.ts` — the single sentence factory
Pure functions, unit-tested (§11.5): `nextStep(parts)`, `cadenceChip(cadence)`,
`closeOutReason(fields)`, `coldTally(tally)`, `quietFor(bizdays)`, `meetingLine(state)`.
No component may embed a board-derived sentence template outside this module.

### 6.6 Draft card
- Chips reclassed: TypeTag for draft type (accented display names), StatusPill for
  staged state.
- `Edit` = real secondary button; `Revise` behavior per §3.4; primary control follows
  the ladder (Draft → Stage → Send…).
- Anchor line from v3 §2.1 (`↳ replies on: PROYECTO UNIVERSIDAD` /
  `✦ starts a fresh thread`) renders under the subject once the thread spine ships
  (Phase E).
- Keep the praised microcopy verbatim: *"Staging puts this reply in Gmail Drafts —
  nothing sends yet."* Extend the pattern: SendModal gains *"Sending is final — this
  leaves for {n} real inbox(es) when you approve."*

---

## 7. Truncation policy (global)

Chrome never truncates meaning. Rules:
1. Reasoning/recommendation text: 1-line clamp + in-place expand, never `…` without an
   expander.
2. Subjects/emails may middle-truncate with `title` attr.
3. Message bodies: never truncated (already true).
4. §11.2 asserts no text node with `text-overflow: ellipsis` lacks an expansion
   affordance in the guidance/footer regions.

---

## 8. Capability decks (v3 §2.1–2.6, incorporated with v4 deltas)

Mechanics per `COCKPIT-V3.md`; v4 changes only naming, placement, and chip classes:

| v3 deck | v4 placement/delta |
|---|---|
| 2.1 Thread spine | THREADS strip renders at the TOP of the CONVERSATION zone as subject-group tabs; per-thread turn = StatusPill (`their move` / `OUR MOVE`); `[Read]` scrolls/filters the zone to that subject-group; anchor pinning + `Start a fresh thread` unchanged |
| 2.2 Files deck | Upload drop-zone in AttachPicker + draft card; attachment-truth copy verbatim from v3 ("Files added inside Gmail do NOT ride along."); product shelf/ficha-by-SKU unchanged (P1) |
| 2.3 Meeting deck | Meeting chip lives in the pane header line; SendModal itemization copy: "THIS SEND ALSO FIRES: calendar invite → …"; confirm-on-send unchanged |
| 2.4 Gate panel | Gate stop rendering uses prose.ts + the §5.4 structured pattern; `[Relabel as warm reply]` etc. as secondary buttons; override-with-reason appends `kind:"override"` (unchanged) |
| 2.5 Cold desk | FreshModal v2 columns (fit, ICP verdict, language, domain-match, junk flags), spread control, junk-close sweep — junk chips are TypeTags; CLOSE AS JUNK is Danger class |
| 2.6 Day ledger | Borradores chip is SUBSUMED by the §4.6 Gmail Drafts chip (already always-on in v4); threading-landed ✓/SPLIT chips = StatusPills on sent rows; DAY LOG collapsible section at rail bottom (P2) |

## 9. Cadence truth (v3.1, incorporated) — §11-open-questions DEFAULTS

v3.1 Parts A+B fold into §5 above. The five §11 questions get these defaults (operator
may override any before Phase D):

1. **COOLING placement** → its own collapsed section, position 7 (§5.1).
2. **Forecast horizon** → 5 business days.
3. **Bulk freeze** → only inside the Cold desk exhausted view (select-all + one
   confirm), not on the main rail.
4. **Fresh-leads button home** → stays in TopBar as `Add leads`.
5. **Draft-anyway vs hard-hide** → soft guard: drafting against a cooling clock is
   allowed with a visible cadence warning card; the send-time hard gate is unchanged.

---

## 10. Data-layer changes (engine + routes)

| Change | File | Detail |
|---|---|---|
| `cold_tally` struct | `core/truth.py` | `{due, not_yet, exhausted}` ints; keep `cold_line` for terminal renderer |
| `frozen_count` int | `core/truth.py` | replaces console's parse of `frozen_line` |
| `close_proposals[]` structured | `core/truth.py` | `{key, whose_turn, reason_kind, evidence_quote, last_dates}` — prose retired from board.json (terminal keeps its own) |
| `cadence` per row + forecast | `core/truth.py` + `core/cadence.py` | v3.1 §4.1–4.2 verbatim |
| `next_step` structured | `core/truth.py` | `{kind, quiet_bizdays?, meeting_at?, …}` alongside `action_parts.engine` during migration; console switches to structured, terminal keeps strings |
| board route whitelist | `src/app/api/board/route.ts` | admit the new fields (route whitelists — a silent-drop hazard; §11.4 fixture asserts they arrive) |
| funnel stats | `src/components/cockpit/CockpitView.tsx:117-126` | D2 implication rule |
| journeys | `src/lib/pipeline.ts` | unchanged (window difference now labeled, not hidden) |

---

## 11. Verification suite (the operator's bar: visible + working, proven)

New: `valence-console/tests/` (Playwright + axe-core; fixture `board.json` +
`packs` frozen under `tests/fixtures/`). CI = `npm run verify:cockpit` run before every
deploy note; a phase is DONE only when its assertions pass in BOTH themes.

### 11.1 Fixture harness
A fixtures mode (`COCKPIT_FIXTURES=1`) makes `/api/board` + `/api/drafts` +
`/api/thread` serve the frozen fixture set (a real anonymized day: drafted row, staged
pack, stale advisory, close proposals, cold tally, meeting states).

### 11.2 Visibility assertions (the D3 class of bug, made impossible to regress)
- Conversation zone height ≥ 40% of pane with a drafted row selected, pre-scroll.
- Every named region (rail, header, zones, jump bar, footer facts) visible with
  height > 0 at 1280×800 and 1440×900.
- No horizontal overflow anywhere; outer page has no scrollable overflow on the Today
  route (exactly two scrollers).
- No clamped text without an expander in guidance/footer regions (§7).
- Every interactive element hit target ≥ 24×24.

### 11.3 Contrast + a11y
- axe-core pass (both themes): zero serious/critical.
- Computed contrast spot-checks on the audit's named offenders: section chevrons, theme
  toggle, Edit button, Revise button, cold block labels, close-out reasoning — each
  ≥ 4.5:1 (or 3:1 if ≥ 18.66px bold).

### 11.4 Data-honesty tests
- Funnel monotonicity on fixtures (D2), including the "drafted yesterday, undecided
  today" case that produced 18→0→16.
- Gmail Drafts chip vs Staged chip from one fixture: labels differ, tooltips present,
  numbers independently correct (D1).
- Board-route whitelist: every §10 field present in the served JSON (silent-drop guard).

### 11.5 Copy + prose tests
- Ban-list grep over `src/components`, `src/app` (System drawer + terminal renderer
  exempt): `\bbd\b`, `ball theirs`, `cadence-exhausted`, `count only`, `board truth`,
  `Certified`, `in limbo`, emoji bullets `🔴|🧊`, `licitacion` (unaccented).
- `text-body` + `ink-faint` co-occurrence lint (§3.2).
- prose.ts unit tests: every generator, every enum branch, no template emits an
  abbreviation from the ban list.
- Exactly one accent-filled primary button per pane (DOM query in fixtures).

### 11.6 e2e flows (fixtures; send mocked DARK)
select row → history visible → jump bar → edit (marker cleared) → revise (busy state)
→ stage → Gmail Drafts chip increments → SendModal itemization renders → gate close-out
modal shows reason field → legend popover opens → theme toggle → repeat visibility spot
checks in light mode.

---

## 12. Build order

| Phase | Scope | Key files | Done when |
|---|---|---|---|
| **A — Data honesty + header** | D1, D2, §4 TopBar (copy, owed-count promotion, chips, one refresh, sending/data-check pills), tab rename, purpose line | TopBar.tsx, CockpitView.tsx, labels, page.tsx | 11.4 + header items of 11.5 pass |
| **B — Geometry** | D3, §6.1 zones + jump bar, page-scroll lock | ThreadPane.tsx (split: ConversationZone/GuidanceZone/ReplyZone + JumpBar), page wrapper | 11.2 passes |
| **C — Visual language + copy sweep** | §3 pill split, ink rules, legend, weight ladder; §2 table applied; prose.ts + engine structured fields (§10) | kit/core.tsx, prose.ts, BoardList.tsx, PackPreview.tsx, truth.py, board route | 11.3 + 11.5 pass |
| **D — Rail restructure + cadence** | §5 sections (incl. Needs a look, Cooling), CadenceChip, cold block, close-outs, §9 defaults | BoardList.tsx, truth.py cadence, core/cadence.py | rail items of 11.2/11.6 pass |
| **E — Capability decks P0** | v3 thread spine, upload, meeting deck, gate panel (§8 deltas) | per COCKPIT-V3 §4 P0a-d | v3 acceptance + 11.6 extensions |
| **F — Cold desk + ledger** | FreshModal v2, template studio, batch view, junk sweep, day log | per COCKPIT-V3 P1/P2 | same |

Phases A–C are pure console + one engine field batch; each is independently shippable
and each ends with the verification suite green. E/F ride on v3's acceptance criteria
plus the v4 visual/copy rules.

---

## 13. Audit traceability appendix

Every audit verdict maps to a section: global orientation → §2/§4.2; scroll → §6.1;
tabs/toggle → §2/§3.5; date/owed/Filter/funnel → §4; sending/certified/drafts/leads/
gear/refresh/banner → §4.4–4.7; meetings strip → §5.1; section headers/hints/dots →
§5.1/§3.3; note pills → §3.1; cold block/closes/frozen → §5.4; contact header/skip →
§6.2; next-step → §6.3; AI box → §6.4; draft card/buttons → §6.6/§3.4; thread
delineation → §6.1; contradiction bugs → §1; truncation → §7; jargon → §2/§0.4.
