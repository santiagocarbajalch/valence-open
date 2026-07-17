# Design of the Valence console

This document expands on the design section of the top-level README. It is the
long version: the doctrine the console is held to, why it reads the way it does,
and the sequence of design eras that got it there. The binding rules live in
[`console/CONSOLE-DOCTRINE.md`](../console/CONSOLE-DOCTRINE.md); the era-by-era
history lives in [`console/DESIGN-LINEAGE.md`](../console/DESIGN-LINEAGE.md).
This file summarizes both for a reader who has not opened them.

## The one idea: a zero-context stranger can operate it

The console has a single acceptance test that outranks every visual choice:
**a stranger with no context could sit down and run the business from it.** The
doctrine states it plainly — every user-facing sentence "reads like a normal
email tool a stranger could operate." Workflow words are allowed (nudge, stage,
freeze, thread). Machinery words are banned: no engine names, file names, enum
values, flag names, snake_case, Zulu timestamps, or count-only shorthand. The
test is literal: "if a stranger would ask 'what does that mean?', it fails."

This is not a style preference. It is enforced in the build. A copy linter
(`console/scripts/copy-lint.mjs`) fails the build when console-speak appears in a
user-facing string, and new jargon discovered in an audit is added to the
ban-list the same day it is fixed. There is exactly one escape hatch: a single
collapsed "Raw engine output" fold in the System status panel, which is the only
place verbatim machine output is allowed to appear.

Every board-derived sentence is generated in one module
(`console/src/components/cockpit/prose.ts`). Components render structured fields
through that one "sentence factory" — never their own inline templates. The
engine emits *facts* (enums, counts, dates, keys); the console turns facts into
English in exactly one place. That is why the language stays consistent no matter
how many surfaces grow.

## No display-only features

The second load-bearing rule: **every button, chip, and link does what it says,
end-to-end, the day it ships.** A control that only changes pixels is removed or
finished — never merged as decoration. Related tenets keep controls honest:

- **Controls never lie about scope.** If a button acts on more than what the
  operator is looking at, its label says so with the real number ("Stage the
  batch (30)").
- **Count = filter.** Any number that is also a filter is computed by the same
  predicate over the same universe as the rows it reveals. If the count says 16,
  clicking it shows 16.
- **Every state is reversible from the UI, or marked destructive.** Freeze has
  Reactivate. Set-aside has Bring back. The three actions with no undo
  (close-out, do-not-contact, send) are styled as danger and sit behind a
  typed/confirmed gate that records a reason.
- **Mutations echo immediately.** A "success toast + unchanged screen" is defined
  as a defect: the operator cannot tell it from broken. State changes write the
  durable record and update the screen in the same interaction.

## Refresh on activity, not on timers

Data reloads because *something happened* — a mutation, newly detected mail — not
because N seconds elapsed. This keeps the screen honest (what you see is the
result of the last real event) and keeps token/API spend tied to actual work.
Its sibling rule: **agent runs are opt-in per click.** Anything that spends model
tokens fires only from an explicit control, states its cost, and never
auto-fires. There is deliberately no sidecar chat window; the model is baked into
the specific features that need it (draft, revise, investigate).

## The operator-authority model, expressed in the UI

The console encodes a specific authority model (see
[`docs/PHILOSOPHY.md`](PHILOSOPHY.md) for the systems side). In the interface it
shows up as two rules:

- **The rail classifies; the pane acts.** The left list files companies into
  groups and never funnels the operator into a single action — no action buttons
  on rail rows. Opening a company presents the full action set (reply, revise,
  meeting, set aside, freeze, close out) with the engine's reasoning beside it.
  "A classification is a suggestion, never a chute."
- **A console action carries the operator's approval; agents never veto it.**
  Anything the operator fires from the console is authorized by that click. The
  agent does the requested work and puts any concern in one plain ADVICE line.
  Refusing the work is a defect. The one thing this does *not* relax is sending —
  that still passes the full send gate every time.

## Weight follows the next step

Exactly one primary button per pane: the recommended next action. Destructive
actions are never the loudest thing on screen. A 2026-07 audit ("volume disease")
produced the "teach on demand" rule — standing explainer paragraphs do not live
inline; every control carries a short plain label and the paragraph that explains
it hides behind a "?" that reveals on hover or keyboard focus. A surface reads as
labels, not walls of text. A parallel ruling reversed an earlier experiment that
surfaced every lead action as its own visible button: visible-button sprawl read
as noise, so all secondary actions fold into a single "More" menu.

## Why it looks the way it looks — the design eras

The current look was not designed once; it was argued into shape across roughly a
dozen eras, each recorded as one paragraph in
[`console/DESIGN-LINEAGE.md`](../console/DESIGN-LINEAGE.md). The throughline:

1. **Pre-rebuild console** — undocumented, later critiqued in retrospect.
2. **Design rebuild** — introduced the `src/components/kit/` token system, still
   the single color/typography access layer today.
3. **Cockpit v3 "The Full Day"** and **v3.1 cadence sections** — gap-analysis and
   cadence planning; parts still serve as the backlog spec.
4. **Cockpit v4 blueprint** ([`console/COCKPIT-V4.md`](../console/COCKPIT-V4.md))
   — the live spec-of-record that merged v3 and v3.1.
5. **V5 / V5.1 operator redesign** — the three-list rail, the Edit+Attach+Send
   card, one Valence box, color-coded triage.
6. **Restyle + kills** — whole surfaces (Workspace, Team, Orbs) removed cleanly;
   the smoke test asserts they stay dead.
7. **Theme iterations** (a borosilicate "bench glass" theme, then the current
   **FRONT OFFICE** shell — navy workflow sidebar, Hanken Grotesk + Red Hat Mono).
8. **Vault galaxy graph** — the knowledge-map view rendered as a volumetric
   star-tree with globe-style gestures.
9. **Pipeline tab** — engine-partition columns beside the Today board.

The lineage doc's maintenance rule mirrors the doctrine's: when a design era ships
or dies, append exactly one paragraph, same cadence, same hand. Superseded full
specs are kept verbatim rather than deleted, because later work still cites them.

## "Well tested" is a deliverable

A feature is not done until `npm run verify:cockpit` is green: copy-lint (the
language tenets), verify-data (the data-honesty tenets), and a fixtures-mode
Playwright smoke that checks the visibility tenets — no crushed panes, no clipped
rows at narrow widths. New features extend the suite in the same change. And
**audits amend the doctrine**: when an operator audit finds a new failure class,
the fix ships *and* the class becomes a tenet or a lint/test, so the next redesign
cannot reintroduce it. The doctrine's amendment log is the running record of that
loop.
