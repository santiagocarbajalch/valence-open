# Valence Console Doctrine

**What this is.** The fixed tenets of this console, distilled from the operator's
audits and rulings (2026-05 → 2026-07). Layouts, colors, components and features
will change; **these rules do not**. Every redesign, every new feature, every
copy edit is checked against this document before it ships.

**Who must read it.** Any human or agent touching `valence-console/`, the board
engine (`core/`), or any surface the operator sees. If a change conflicts with a
tenet, the tenet wins — or the operator explicitly amends this file (date-stamped
at the bottom). Nothing else overrides it.

---

## 1. Language

1. **Plain language everywhere.** Every user-facing sentence reads like a normal
   email tool a stranger could operate. Workflow words are fine (nudge, stage,
   freeze, thread). Machinery words are not: no engine names, file names, enum
   values, flag names, API params, snake_case, Zulu timestamps, or count-only
   shorthand. If a stranger would ask "what does that mean?", it fails.
2. **One sentence factory.** Every board-derived sentence the console shows is
   written in exactly one module (`src/components/cockpit/prose.ts`). Components
   render structured fields through it — never their own inline templates. The
   engine emits **facts** (enums, counts, dates, keys), not display prose.
   *(Parity rule: the certifier checks the facts; prose is per-surface.)*
3. **One raw surface.** Verbatim engine output lives behind a single collapsed
   "Raw engine output" fold in System status — nowhere else. That fold is the
   only copy-lint exemption. Even System status reads plain by default.
4. **The ban-list is enforced, not remembered.** `scripts/copy-lint.mjs` fails
   the build on console-speak. New jargon found in an audit gets ADDED to the
   ban-list the same day it's fixed. Repair layers (`prose.ts`, `labels.ts`)
   may name banned phrases; nothing else may.
5. **No emojis.** Monochrome glyphs only (✓ ✎ ✦ ● ▸). Color comes from tone
   tokens, never from emoji.
6. **One verb per action, everywhere.** The menu item, the dialog title and the
   confirm button use the SAME verb ("Close out" is close-out on all three).
   Time is always spelled out ("3 business days", local wall-clock times).

## 2. Data honesty

7. **One truth per fact.** Every displayed fact has exactly one durable source
   (a marker file, a registry, a log). No heuristics that "usually agree" with
   the real source — when a heuristic is found propping up a number, replace it
   with the real source and delete the heuristic.
8. **Count = filter.** Any number that is also a filter must be computed by the
   SAME predicate over the SAME universe as the rows the filter shows. If the
   count says 16, clicking it shows 16.
9. **Same unit, or say so.** Two numbers rendered near each other either count
   the same thing or their labels say explicitly what each counts ("Gmail
   Drafts · packs waiting" vs today's "Staged" companies).
10. **States are disjoint.** A company lives in exactly ONE list at a time. If
    two classifications compete (owed reply vs close suggestion), a stated
    precedence decides — never both rows.
11. **Mutations echo immediately.** Any action that changes state must be
    visible in the UI within the same interaction: write the durable record,
    hide/show optimistically, force the engine echo, honestly revert if the
    engine disagrees. "Success toast + unchanged screen" is a defect by
    definition — the operator cannot tell it from broken.
12. **Refresh on activity, never on timers.** Data reloads because something
    happened (a mutation, new mail detected), not because N seconds passed.

## 3. Controls

13. **No display-only affordances.** Every button, chip and link does what it
    says, end-to-end, the day it ships. A control that only changes pixels is
    removed or finished — never merged as-is.
14. **Controls never lie about scope.** If a button acts on more than what the
    operator is looking at (a batch, a pack, other companies' mail), its label
    and confirmation say so with the real number ("Stage the batch (30)").
15. **Every state is reversible from the UI, or marked destructive.** Freeze has
    Reactivate. Set-aside has Bring back. Anything without an undo (close-out,
    do-not-contact, send) is styled as danger, sits behind a typed/confirmed
    gate, and records a reason.
16. **Idempotent + no silent clobber.** Re-applying a state says "already done"
    instead of re-firing. An action that would overwrite an existing operator
    state warns first.
17. **Weight follows the next step.** Exactly one primary button per pane — the
    recommended next action. Destructive is never the loudest. Disabled-looking
    ≠ waiting-for-input.
    *(2026-07-17 note: the V5.1 "surface every lead action as its own visible
    button" experiment is REVERSED — operator ruling 2026-07-16. A pane carries
    one primary next action; every other lead action folds into a single
    "More ▾" menu. Visible-button sprawl reads as noise, not clarity.)*
18. **The rail classifies; the pane acts.** The left list files companies and
    never funnels you into a single action — no action buttons on rail rows or
    rail footers. Opening a company presents the FULL action set (reply, revise,
    meeting, set aside, freeze, close out) with the engine's reasoning beside
    it. A classification is a suggestion, never a chute.
19. **Feedback lives where the work is.** Long-running work shows its progress
    ON the thing it will change (the draft body itself shows "revising…", then
    the new text, in place) — and the result must be visible where the operator
    is already looking, without hunting. Corner toasts are only for events with
    no on-screen home. Progress for step A must never borrow step B's language
    (a revision never says anything about staging or Gmail).

## 4. Structure

20. **The engine classifies; the console renders.** Triage, buckets, cadence and
    suppression are computed once in the engine from durable registries. The
    console never re-derives a classification — it may only partition a section
    by an engine enum for display.
21. **Registries are the memory.** Operator decisions (freeze, close, dnc,
    meetings, test identities, set-aside) live in durable vault files that
    survive every regen. The engine reads them as the LAST word. UI state is
    never the only place a decision exists.
22. **The unit of work = the unit the operator thinks in.** Company is the unit
    of truth; one warm reply = one pack = one stage = one send approval. Bulk
    units (cold batches) exist only where bulk is the operator's actual intent,
    and are labeled as bulk.
23. **Guards live server-side.** Mutual exclusions (frozen ⇒ no draft/stage,
    same-company recipient edits, warm-pack single-company) are enforced in the
    API routes with a plain-language refusal — the UI merely reflects them.
24. **The send gate is sacred.** Default-DENY, verbatim typed approval,
    recipient-scoped single-use grants, cap and pacing. New features route
    AROUND the gate (e.g. invite fires at approved send), never through a
    weakened version of it. "Print inline" is never send approval.
25. **Agent runs are opt-in per click.** Anything that spends tokens fires only
    from an explicit control, states its cost, and never auto-fires. No sidecar
    chat — the LLM is baked into features (draft, revise, investigate).

## 5. Proof

26. **"Well tested" is a deliverable.** A feature is DONE when
    `npm run verify:cockpit` is green: copy-lint (language tenets), verify-data
    (data-honesty tenets), and the fixtures-mode smoke (visibility tenets — no
    crushed panes, no clipped rows at narrow widths, orientation layer present).
    New features extend the suite in the same change.
    *(2026-07-17 addendum: the background-work tray is an OVERLAY — a work pill
    in the sidebar foot that opens a `position: fixed` drawer above the content,
    never a flex sibling of the main pane. Opening it must not reflow the page;
    the smoke asserts the main pane keeps its geometry with the drawer open.)*
27. **Test on yourself before customers.** The test-lead sandbox (System status)
    proves the full pipeline — draft → stage → gate → real send — against the
    operator's own inbox. Risky send-path changes are verified there FIRST.
28. **Audits amend the doctrine.** When an operator audit finds a new failure
    class, the fix ships AND the class becomes a tenet or a lint/test here, so
    it cannot be reintroduced by the next redesign.
29. **A console action carries the operator's approval — agents never veto it.**
    Anything the operator fires from the console is, by that click, explicitly
    authorized: the agent does the requested work and puts any concern in one
    plain ADVICE line for the operator to weigh. Refusing the work is a defect.
    This changes nothing about tenet 24 — drafting/reading/revising are
    operator-approved by the click; SENDING still passes the full send gate.

30. **Teach on demand.** Standing explainer prose does not live inline on the
    surface. Every control, section and count carries a plain, short label; the
    paragraph that explains it lives behind a "?" affordance that reveals on
    hover OR keyboard focus. A surface reads as labels, not walls of text — the
    teaching is one gesture away, never in the way. (Sibling of tenet 1, plain
    language, and tenet 17, one primary action: the ruling that produced this
    tenet is the 2026-07-16 audit — "volume disease", paragraphs crowding out
    the work.)

---

### How to apply this to a new feature (checklist)

- [ ] Every sentence through `prose.ts`; copy-lint green; no new jargon.
- [ ] Every number: one durable source; count = filter; unit labeled.
- [ ] Every control: end-to-end, honest scope, reversible or gated, idempotent.
- [ ] State changes: durable registry + immediate visible echo.
- [ ] Guards server-side; send gate untouched; agent calls opt-in.
- [ ] verify:cockpit extended and green; test-lead run if the send path moved.

### Amendments
- 2026-07-04 — v1. Distilled from the V4 blueprint (§0 charter), the 2026-07-04
  operator audits (passive + active + deep), and the V4.1 rebuild rulings
  (per-company staging, same-company To edits, test-lead sandbox, System drawer
  plain + raw fold).
- 2026-07-04 — v1.1 (operator ruling). Added tenet 18 "the rail classifies; the
  pane acts" (close-out buttons removed from the rail; action + reasoning moved
  to the conversation pane). Test identities are VISIBLE work items (TEST tag,
  full board presence, excluded from cold ladder + close-outs) — amended tenet
  26's mechanism: inbound mail from a test identity surfaces like a real lead.
  Meetings strip renders structured affordances (date, company, status, Meet
  link that opens the call).
- 2026-07-04 — v1.2 (operator ruling, live test run). Added tenet 19 "feedback
  lives where the work is": revise-with-agent now renders progress and result
  on the draft body itself (overlay + in-place update + inline confirmation);
  revision toasts removed; revise never speaks staging language. Staging stays
  a fully separate step.
- 2026-07-11 — v1.4 (operator ruling, verbatim in substance: "Anything that
  runs on the console has immediate and innate operator approval… a directive
  that should not ever be broken"). Added tenet 29: console-fired agent runs
  are operator-approved by the click; agent judgment surfaces as an ADVICE
  line, never as a refusal. Trigger: the draft agent declined to draft a reply
  the operator had explicitly requested (troll-mail row). Send gate (tenet 24)
  is explicitly unchanged.
- 2026-07-17 — v1.5 (CALIBRATED INSTRUMENT port; operator-locked design
  identity "Plex · Comfort · Trade", accepted from the design-lab mockup).
  Tenet 17 note: the V5.1 "visible buttons" experiment is reversed (operator
  2026-07-16) — one primary next action + a single "More ▾" menu. New tenet 30
  "teach on demand": standing explainer prose lives behind a "?" affordance;
  surfaces carry plain labels, not paragraphs (2026-07-16 "volume disease"
  audit). Tenet 26 addendum: the background-work tray is a fixed overlay drawer
  reached from a sidebar work pill — never a flex sibling that reflows the page.
- 2026-07-04 — v1.3 (operator ruling). The pipeline-stage funnel/filter
  (Arrived → Decided → Drafted → Staged → Sent) is retired: the workflow
  completes on one screen, so stage-filtering the list served nothing. The bar
  carries plain CLASSIFICATION counters (gone quiet, close-outs, waiting, cold
  due, bid desk, added today, set aside) that open their group in the rail —
  each counter equals its group's rows by construction. Rule of thumb going
  forward: orient by classification, never by pipeline stage.
