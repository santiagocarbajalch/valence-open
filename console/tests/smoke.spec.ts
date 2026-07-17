// V5 smoke (operator redesign 2026-07-10) — read-only over the fixtures server.
// Mutating flows (freeze/unfreeze/send/meeting) are verified live by hand and
// by scripts/verify-data.mjs; this spec asserts VISIBILITY invariants: the
// three plain lists, no counter chips, nothing crushed, overlays open.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // CALIBRATED INSTRUMENT (Phase T, 2026-07-17): rail sections are eyebrow
  // labels (label + mono count), not <h2> headings.
  await expect(page.getByText("They're waiting on you").first()).toBeVisible({ timeout: 20_000 });
});

test("hero: a large mono owed counter (no counter chips, no cap counter, no green pills)", async ({ page }) => {
  // the loudest element is the counter + its "Need(s) a reply" / "Nothing owed" lead
  await expect(page.getByRole("button", { name: /Need(s)? a reply|Nothing owed/i })).toBeVisible();
  // the 8-group count strip is dead
  await expect(page.getByRole("navigation", { name: "Board groups" })).toHaveCount(0);
  // cap telemetry is dead (operator rule: never surface a cap)
  await expect(page.getByText(/\/50 sent today/)).toHaveCount(0);
  // green always-on pills are dead — safety states speak only on failure
  await expect(page.getByText("Data checked ✓")).toHaveCount(0);
  await expect(page.getByText("Sending: LIVE")).toHaveCount(0);
});

test("rail: eyebrow sections with mono counts; chip-only assay rows, gist only on hover", async ({ page }) => {
  await expect(page.getByText("They're waiting on you").first()).toBeVisible();
  await expect(page.getByText("Waiting on them").first()).toBeVisible();
  // the old jargon buckets are gone as group headers
  for (const dead of ["Reply now", "Needs a look", "Gone quiet", "In your hands", "On hold", "Bid desk (public sector)"]) {
    await expect(page.getByRole("heading", { name: dead })).toHaveCount(0);
  }
  // no sent/replies tally chips on rows
  await expect(page.getByText(/\d+ sent · \d+ repl/)).toHaveCount(0);
  // rows are assay strips: the gist card is hidden at rest, revealed on hover
  const row = page.locator(".vk-railrow").first();
  await expect(row).toBeVisible();
  const gist = row.locator(".rr-gist");
  await expect(gist).toBeHidden();
  await row.hover();
  await expect(gist).toBeVisible();
});

test("no horizontal page overflow at 1280 and at 680", async ({ page }) => {
  for (const width of [1280, 680]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `page overflows horizontally at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test("selecting a row shows the conversation with real height + jump bar", async ({ page }) => {
  const rail = page.locator("section[aria-label='Companies by priority']");
  await expect(rail.first()).toBeVisible();
  // conversation region present (auto-selected most urgent row on load)
  const convo = page.getByText(/message(s)? ·/).first();
  await expect(convo).toBeVisible({ timeout: 20_000 });
  // pinned reply bar tells the draft state in operator words (no staging-speak)
  await expect(page.getByText(/No draft yet|Draft ready below|Reply sent today/).first()).toBeVisible();
  await expect(page.getByText(/not staged/)).toHaveCount(0);
});

test("system drawer opens plain from the rail link, raw engine output folded", async ({ page }) => {
  await page.getByRole("button", { name: "System status →" }).click();
  await expect(page.getByRole("heading", { name: "Data check" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sending" })).toBeVisible();
  const raw = page.getByRole("button", { name: "Raw engine output" });
  await expect(raw).toBeVisible();
  await expect(raw).toHaveAttribute("aria-expanded", "false");
  // machinery strings are NOT on screen until the fold opens
  await expect(page.getByText(/truth\.py/)).toHaveCount(0);
  await raw.click();
  await expect(page.getByText(/truth\.py/).first()).toBeVisible();
  await page.keyboard.press("Escape");
});

// ── directives + the one Valence box ─────────────────────────────────────────

test("held and personal rows fold into Waiting on them with their state words", async ({ page }) => {
  // fixture: one held row (return date) + one personal row ("yours")
  await expect(page.getByText(/back Jul 7/)).toBeVisible();
  await expect(page.getByText("yours", { exact: true })).toBeVisible();
});

test("held row: the More menu offers Bring back now + Handling personally; Valence box present", async ({ page }) => {
  await page.getByRole("button", { name: /andes-scientific\.example\.com/ }).click();
  // the lead actions live behind ONE "More ▾" menu now (operator 2026-07-16)
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Bring back now" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Handling personally" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder(/Tell Valence/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Go", exact: true })).toBeVisible();
});

test("hold flow: Hold until… (in the More menu) opens the date picker with quick picks", async ({ page }) => {
  // a live, not-yet-held row offers "Hold until…" in its More menu
  await page.getByRole("button", { name: /delta-instruments\.example\.com/ }).first().click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Hold until…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tomorrow" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Next Monday" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("follow-up-due row: Nudge now is the recommended action (cadence intact)", async ({ page }) => {
  // the 3-business-day cadence still surfaces: the row carries "follow up"
  await expect(page.getByText(/follow up — quiet/).first()).toBeVisible();
  await page.getByRole("button", { name: /delta-instruments\.example\.com/ }).click();
  await expect(page.getByRole("button", { name: /Nudge now/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft a full reply" })).toBeVisible();
});

test("the one Valence box runs on submit — no confirm popup, cost stated inline", async ({ page }) => {
  const input = page.getByPlaceholder(/Tell Valence/);
  await expect(input).toBeVisible();
  // it is the ONLY agent entry on the screen — no Rewrite box, no preset chips
  await expect(page.getByRole("button", { name: "Rewrite" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Draft this one in English" })).toHaveCount(0);
  // tenet 25 now teaches on demand: the cost + preloaded context + never-sends
  // explainer lives behind a "?" hint (same words), revealed on hover/focus
  const hint = page.getByRole("button", { name: "What running Valence does" });
  await expect(hint).toBeVisible();
  await hint.hover();
  await expect(page.getByText(/one agent run/)).toBeVisible();
  await expect(page.getByText(/never sends email/)).toBeVisible();
  // empty box → the run control is disabled (no accidental token spend)
  const go = page.getByRole("button", { name: "Go", exact: true });
  await expect(go).toBeDisabled();
  // submit fires the agent run DIRECTLY — no dialog in between (operator
  // 2026-07-12). The workbench call is stubbed: no real agent in the smoke.
  await page.route("**/api/workbench", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, jobId: "smoke-noop" }) }));
  await page.route("**/api/job*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ running: true, code: null, out: "", err: "" }) }));
  await input.fill("Summarize where this deal stands");
  await go.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/Valence is working on it/)).toBeVisible();
});

test("a set-aside company lives in a NAMED subgroup and offers Bring back today", async ({ page }) => {
  // fixture: meridian-lab.example.com is skip-decided — it must be findable the same day
  // (operator 2026-07-11: the parked row was invisible, no rescue path)
  const group = page.locator("[data-aside-group]");
  await expect(group).toBeVisible();
  await expect(group.getByText(/Set aside until tomorrow/)).toBeVisible();
  const row = group.getByRole("button", { name: /meridian-lab\.example\.com/ });
  await expect(row).toBeVisible();
  await row.click();
  // the rescue lives in the More menu now (operator 2026-07-16 — one menu)
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Bring back today" })).toBeVisible();
});

test("a first-contact sender (never emailed by us) rides the owe list with its state word", async ({ page }) => {
  // fixture: engine lane "contacted" — someone wrote in without any outreach
  // from us on record (operator ruling 2026-07-11: visible, never count-only)
  const row = page.getByRole("button", { name: /firstcontact-fixture@example\.com/ });
  await expect(row.first()).toBeVisible();
  await expect(page.getByText("wrote in first")).toBeVisible();
  // opening it presents the normal pane (full action set, not a chute)
  await row.first().click();
  await expect(page.getByPlaceholder(/firstcontact-fixture@example\.com/)).toBeVisible();
});

test("cold list pre-groups by template: group header carries Send all, loose rows say why not", async ({ page }) => {
  // fixture cold-batch.json: one Spanish · 2nd follow-up group (nova-diagnostics.example.com)
  // + one address the plan can't batch (no earlier email on file)
  const group = page.locator("[data-cold-group='spanish-cold-02']");
  await expect(group).toBeVisible({ timeout: 20_000 });
  await expect(group.getByText(/Spanish · 2nd touch of 3 — same email to all 1/)).toBeVisible();
  await expect(group.getByRole("button", { name: "Send all 1…" })).toBeVisible();
  // the unbatchable row is still on the board (nothing vanishes) with its reason
  await expect(page.getByText("One at a time — these can't join a group")).toBeVisible();
  await expect(page.getByText("no earlier email on file")).toBeVisible();
  // opening the group's send flow: NO agent run fires on open (tenet 25; lazy-
  // generation audit fix 2026-07-17). Stub the two agent endpoints to catch any
  // auto-fire — the modal must reach a reviewable state without either.
  let coldBatchPosts = 0, workbenchPosts = 0;
  await page.route("**/api/cold-batch", (route) => {
    if (route.request().method() === "POST") coldBatchPosts++;
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, file: "x.json", count: 1 }) });
  });
  await page.route("**/api/workbench", (route) => {
    if (route.request().method() === "POST") workbenchPosts++;
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, jobId: "smoke-noop" }) });
  });

  await group.getByRole("button", { name: "Send all 1…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Send to the whole group · Spanish · 2nd touch of 3/)).toBeVisible();
  // fixtures serve the already-written pack (drafts-pack): a read-only peek finds
  // it, so the sample shows straight away — WITHOUT any writing-agent run
  await expect(dialog.getByText(/1 company gets this exact email/)).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText(/Estimado equipo de Nova Diagnostics/)).toBeVisible();
  expect(coldBatchPosts, "opening the modal must not auto-generate drafts").toBe(0);
  // the group rewrite strip survives the port
  await expect(dialog.getByText("Rewrite this email — the change applies to the whole group")).toBeVisible();
  // scope-honest control: the button names the real group size, waits for input
  const rewrite = dialog.getByRole("button", { name: "Rewrite all 1" });
  await expect(rewrite).toBeVisible();
  await expect(rewrite).toBeDisabled();
  await dialog.getByLabel("Rewrite instruction for the whole group").fill("shorter");
  await expect(rewrite).toBeEnabled();
  // the checks step is still the one primary next action
  await expect(dialog.getByRole("button", { name: "Looks right — check all 1" })).toBeVisible();
  expect(workbenchPosts, "no rewrite fires until the operator clicks").toBe(0);
  await page.keyboard.press("Escape"); // no agent run, no staging in the smoke
  await expect(dialog).toHaveCount(0);
});

test("cold group send: with no drafts on disk yet, the sample waits behind an explicit Write button (no auto-fire)", async ({ page }) => {
  // force the read-only peek to find nothing → the "No drafts written yet" state
  await page.route("**/api/drafts**", (route) => {
    const req = route.request();
    if (req.method() === "GET" && req.url().includes("file=")) {
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ file: "none", pack: { drafts: [] } }) });
    } else route.continue();
  });
  let coldBatchPosts = 0;
  await page.route("**/api/cold-batch", (route) => {
    if (route.request().method() === "POST") coldBatchPosts++;
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, file: "x.json", count: 1 }) });
  });
  const group = page.locator("[data-cold-group='spanish-cold-02']");
  await expect(group).toBeVisible({ timeout: 20_000 });
  await group.getByRole("button", { name: "Send all 1…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("No drafts written yet.")).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText(/1 company gets this exact email/)).toBeVisible();
  // the agent only runs from this explicit, cost-stated control
  await expect(dialog.getByRole("button", { name: "Write the 1 draft…" })).toBeVisible();
  expect(coldBatchPosts, "nothing generates until the Write button is clicked").toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a sent draft is history: the reply zone says sent and never offers Send again", async ({ page }) => {
  // fixture: acme-labs.example.com's drafted pack has a matching sent record (packSent).
  // 2026-07-12: a delivered draft kept a live Send button and the pane
  // contradicted itself — the sent state must replace the pending card.
  await page.getByRole("button", { name: /acme-labs\.example\.com/ }).click();
  await expect(page.getByText(/Reply sent .*conversation above/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft another reply" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Send…$/ })).toHaveCount(0);
});

test("draft card: edit, attach and Send are the controls — no staging apparatus", async ({ page }) => {
  // cumbre-medica.example.com has a live draft — the card shows Edit + attach and one Send
  await page.getByRole("button", { name: /cumbre-medica\.example\.com/ }).first().click();
  const send = page.getByRole("button", { name: /^Send…$|^Preparing…$/ });
  if (await send.count()) {
    await expect(page.getByRole("button", { name: "✎ Edit" })).toBeVisible();
    await expect(page.getByText(/Attach files…|Change attachments/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Stage to Gmail Drafts" })).toHaveCount(0);
  }
});

test("attachments exist BEFORE a draft does: pick files now, they ride the next draft run", async ({ page }) => {
  // fixture: delta-instruments.example.com has no draft yet — the reply zone must still offer the
  // asset library (the 2026-07-16 audit: the picker was invisible pre-draft).
  // The trigger lives in the More menu now (Phase T — one menu total).
  await page.getByRole("button", { name: /delta-instruments\.example\.com/ }).first().click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Attach files…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // pick-mode names its contract: nothing writes now, the files ride the draft
  await expect(dialog.getByRole("button", { name: "Attach when it drafts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a draft older than their latest message says so and puts the weight on drafting fresh", async ({ page }) => {
  // fixture: cumbre-medica.example.com's draft day (2026-07-01) predates their last inbound
  // (2026-07-02) — the freshness guard extends the delta-instruments staleness ruling to
  // inbound mail (2026-07-16): loud warning, fresh-draft primary, Send demoted
  await page.getByRole("button", { name: /cumbre-medica\.example\.com/ }).first().click();
  await expect(page.getByText(/before their latest message/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Draft a fresh reply/ })).toBeVisible();
  // the old draft is still sendable — the operator decides, the console just says
  await expect(page.getByRole("button", { name: /^Send…$/ })).toHaveCount(1);
});

test("a proposed time slot surfaces Confirm meeting in the More menu; no slot, no item", async ({ page }) => {
  // fixture: sierra-lab.example.com's last message proposes "este viernes a las 1330
  // UTC-4" — the packaged confirm-meeting run gets its own menu item
  await page.getByRole("button", { name: /sierra-lab\.example\.com/ }).first().click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Confirm meeting" })).toBeVisible();
  await page.keyboard.press("Escape");
  // acme-labs.example.com's last message proposes nothing — the item must not render
  await page.getByRole("button", { name: /acme-labs\.example\.com/ }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Confirm meeting" })).toHaveCount(0);
});

test("the house sales-conditions sentence is one click away in the draft editor", async ({ page }) => {
  await page.getByRole("button", { name: /cumbre-medica\.example\.com/ }).first().click();
  await page.getByRole("button", { name: "✎ Edit" }).click();
  const insert = page.getByRole("button", { name: "+ Insert sales conditions (EXW)" });
  await expect(insert).toBeVisible();
  await insert.click();
  // fixture draft is Spanish → the canonical ES sentence, verbatim
  await expect(page.getByLabel("Body")).toHaveValue(/Nuestras condiciones de venta son EXW, con el pago antes del embarque\./);
});

test("reply zone: the More menu holds every lead action plus the destructive trio", async ({ page }) => {
  // Phase T (operator 2026-07-16): one primary + ONE "More ▾" menu. On a live,
  // not-held, not-personal row every other lead action is a menu item.
  await page.getByRole("button", { name: /delta-instruments\.example\.com/ }).first().click();
  await page.getByRole("button", { name: "More actions" }).click();
  for (const item of ["Schedule meeting", "Hold until…", "Handling personally",
    "Set aside until tomorrow", "Attach files…", "Investigate with the agent…",
    "Pause (reversible)", "Close out — mark declined", "Do not contact"]) {
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
  }
});

test("reply zone: exactly ONE primary action in the pane (tenet 17)", async ({ page }) => {
  await page.getByRole("button", { name: /delta-instruments\.example\.com/ }).first().click();
  // the conversation pane carries a single accent/filled primary — Nudge now —
  // with the rest quiet (secondary) or inside More. Draft a full reply is neutral.
  const primaries = page.locator("section[aria-label='Conversation'] button.vk-btn-primary");
  await expect(primaries).toHaveCount(1);
  await expect(primaries.first()).toHaveText(/Nudge now/);
});

test("scraping tab: three retitled zones, stat chips, no veins list; a batch opens into its companies and offers the named first-email flow", async ({ page }) => {
  await page.getByRole("button", { name: "Scraping" }).click();
  // CALIBRATED INSTRUMENT (2026-07-17): the three zones are retitled
  await expect(page.getByRole("heading", { name: "New dig" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dig in progress" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Landed batches" })).toBeVisible();
  // the "What's worked before" veins list left the standing surface
  await expect(page.getByText("What's worked before")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Argentina — Lab equipment distributors/ })).toHaveCount(0);
  // the pool numbers ride as state chips now
  await expect(page.getByText("397 uncontacted")).toBeVisible();
  await expect(page.getByText("742 verified")).toBeVisible();
  // the category picker speaks the tool's human labels, never the machine key
  await expect(page.getByLabel("Category").locator("option", { hasText: "Lab equipment distributors (non-US)" })).toHaveCount(1);
  // no machine jargon anywhere on the sheet (2026-07-12 audit)
  await expect(page.getByText("ICP gate")).toHaveCount(0);
  // a landed batch carries landed/new chips (fresh = never emailed)
  await expect(page.getByText("5 landed")).toBeVisible();
  await expect(page.getByText("1 new")).toBeVisible();
  // a batch with nothing recorded still names itself instead of rendering "— · —"
  await expect(page.getByRole("button", { name: "type not recorded — region not recorded" })).toBeVisible();
  // the sheet holds together at narrow widths (no sideways scroll)
  await page.setViewportSize({ width: 680, height: 900 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "scraping tab overflows horizontally at 680px").toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  // opening the batch shows the companies inside, contacted ones labeled
  await page.getByRole("button", { name: "Lab equipment distributors — Ecuador", exact: true }).click();
  await expect(page.getByText("info@vitalab.example.com")).toBeVisible();
  // the source scoreboard folds open with plain state words
  await page.getByText(/Where we've dug/).click();
  await expect(page.getByText("giving leads")).toBeVisible();
  await expect(page.getByText("never dug")).toBeVisible();
  // a11y fix: the first-email action names its batch ("Email N fresh — <batch>…")
  await page.getByRole("button", { name: "Email 1 fresh — Lab equipment distributors — Ecuador…" }).click();
  const dialog = page.getByRole("dialog", { name: /First email to the fresh leads/ });
  await expect(dialog.getByText(/1 company is fresh/)).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole("button", { name: "Write the 1 email" })).toBeVisible();
  await dialog.getByText(/Left out \(4\)/).click();
  await expect(dialog.getByText(/4 — already emailed before/)).toBeVisible();
  await page.keyboard.press("Escape"); // no drafts written, nothing staged in the smoke
  await expect(dialog).toHaveCount(0);
});

// ── the Pipeline tab (2026-07-12): the whole field, one column per engine
// partition; the only bulk control is pausing ladder-finished cold leads ─────

test("pipeline tab: three action cards + four count-headers; a count-header expands to its own rows", async ({ page }) => {
  await page.getByRole("button", { name: "Pipeline", exact: true }).click();
  // CALIBRATED INSTRUMENT (2026-07-17): the live-work partitions render as
  // eyebrow-headed action cards…
  for (const col of ["Their move", "Your move", "Meetings"]) {
    await expect(page.getByText(col, { exact: true }).first()).toBeVisible();
  }
  // …and the heavy/dead partitions as collapsed count-headers
  for (const col of ["Cold ladder", "Finished the ladder", "Paused", "Closed as declined"]) {
    await expect(page.getByRole("button", { name: new RegExp(col) })).toBeVisible();
  }
  // a count-header is collapsed at rest (no rows), then expands inline
  const finished = page.locator("#pipeline-col-finished");
  const finishedToggle = finished.getByRole("button", { name: /Finished the ladder/ });
  await expect(finishedToggle).toHaveAttribute("aria-expanded", "false");
  expect(await finished.locator(".vk-railrow").count()).toBe(0);
  await finishedToggle.click();
  await expect(finishedToggle).toHaveAttribute("aria-expanded", "true");
  // count = filter (tenet 8): the header's number equals the rows it reveals
  await expect(finishedToggle).toContainText("237");
  expect(await finished.locator(".vk-railrow").count()).toBe(237);
  // ladder rows say their position in plain words (ladder pips' accessible name)
  const ladder = page.locator("#pipeline-col-ladder");
  await ladder.getByRole("button", { name: /Cold ladder/ }).click();
  await expect(ladder.getByRole("img", { name: /touch 2 of 3 scheduled/ }).first()).toBeVisible();
  // no page-level horizontal overflow at any supported width
  for (const width of [1280, 680]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `pipeline overflows horizontally at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test("pipeline: a paused row (in the Paused expansion) tells its story in the drawer and offers Reactivate", async ({ page }) => {
  await page.getByRole("button", { name: "Pipeline", exact: true }).click();
  const paused = page.locator("#pipeline-col-paused");
  await paused.getByRole("button", { name: /Paused/ }).click(); // expand the count-header
  await paused.getByRole("button", { name: /castillo-quimica\.example\.com/ }).click();
  const drawer = page.getByRole("dialog");
  // the registry's reason and date render in the drawer — no JSON spelunking
  await expect(drawer.getByText(/paused Jun 30 — Nudged past pacing guidance; door open a futuro\./).first()).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Reactivate" })).toBeVisible();
  await expect(drawer.getByText(/back on its worklists right away/)).toBeVisible();
  await page.keyboard.press("Escape");
});

test("pipeline: bulk pause lives inside the Finished expansion — scope-honest and gated", async ({ page }) => {
  await page.getByRole("button", { name: "Pipeline", exact: true }).click();
  const finished = page.locator("#pipeline-col-finished");
  await finished.getByRole("button", { name: /Finished the ladder/ }).click(); // expand
  // nothing selected → the control waits
  await expect(finished.getByRole("button", { name: "Pause selected (0)…" })).toBeDisabled();
  // select all names the real number everywhere: link, button, dialog, confirm
  await finished.getByRole("button", { name: "Select all 237" }).click();
  const arm = finished.getByRole("button", { name: "Pause selected (237)…" });
  await expect(arm).toBeEnabled();
  await arm.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Pause 237 companies")).toBeVisible();
  // reason is required — the confirm stays disabled until one is typed
  await expect(dialog.getByRole("button", { name: "Pause all 237" })).toBeDisabled();
  await page.keyboard.press("Escape"); // nothing written in the smoke
  await expect(dialog).toHaveCount(0);
});

test("pipeline: a live row's drawer shows the shared conversation and points work at Today", async ({ page }) => {
  await page.getByRole("button", { name: "Pipeline", exact: true }).click();
  await page.locator("#pipeline-col-yours").getByRole("button", { name: /delta-instruments\.example\.com/ }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "Conversation" })).toBeVisible();
  // ONE DESK: the drawer renders Today's bubble conversation (same component),
  // and the hand-off control replaces the old "go find it yourself" sentence
  await expect(drawer.getByRole("button", { name: "Open on Today" })).toBeVisible();
  await expect(drawer.getByText(/lands with this company already selected/)).toBeVisible();
  // gates only — the drawer never grows a second draft/send path
  await expect(drawer.getByRole("button", { name: /Send/ })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: /Draft/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("pipeline → Open on Today lands on the cockpit with the company preselected", async ({ page }) => {
  await page.getByRole("button", { name: "Pipeline", exact: true }).click();
  await page.locator("#pipeline-col-yours").getByRole("button", { name: /delta-instruments\.example\.com/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Open on Today" }).click();
  // the drawer closes, the shell switches to Today, and the row is selected
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "delta-instruments.example.com" })).toBeVisible();
  await expect(page.locator("[aria-current='true']").filter({ hasText: "delta-instruments.example.com" })).toBeVisible();
});

test("one pause vocabulary: Today's menu and dialog say Pause, never Freeze", async ({ page }) => {
  await page.getByRole("button", { name: /delta-instruments\.example\.com/ }).first().click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Pause (reversible)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Pause · delta-instruments\.example\.com/)).toBeVisible();
  await expect(dialog.getByText(/Freeze/)).toHaveCount(0);
  // the reason gate holds: no reason, no pause
  await expect(dialog.getByRole("button", { name: "Pause", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

// ── the 2026-07-12 restructure: Vault tab + System sub-tabs ──────────────────

test("sidebar: the six workflow views stand as a flat navy rail; Workspace and Files are gone", async ({ page }) => {
  // CALIBRATED INSTRUMENT shell (2026-07-17): the navy sidebar is a FLAT rail —
  // wordmark, six items with monochrome glyphs, then a foot (work pill + theme
  // + operator line). The workflow group labels retired with the mockup.
  const bar = page.getByRole("navigation", { name: "Console navigation" });
  for (const alive of ["Today", "Pipeline", "Scraping", "Vault", "System", "Valence"]) {
    await expect(bar.getByRole("button", { name: alive, exact: true })).toBeVisible();
  }
  await expect(bar.getByRole("button", { name: "Workspace" })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Files", exact: true })).toHaveCount(0);
  // the foot carries the operator line and the theme toggle
  await expect(bar.getByText("Operator · sole operator")).toBeVisible();
  await expect(bar.getByRole("button", { name: /Switch to (day|night)/ })).toBeVisible();
});

test("vault tab: the 3D map on top, the file navigator a scroll below — no sub-tabs", async ({ page }) => {
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  // the map's orientation layer (legend + honest stats from the vault walk)
  await expect(page.getByText("BIGGER STAR = MORE FILES INSIDE")).toBeVisible();
  await expect(page.getByText(/agents · .+ folders · .+ files · .+ cross-references/)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 20_000 });
  // the reframe control is real and present once the map is up
  await expect(page.getByRole("button", { name: "See everything" })).toBeVisible({ timeout: 20_000 });
  // the way down is always on screen (the canvas eats scroll-wheel for zoom)
  await expect(page.getByText("BROWSE THE FILES")).toBeVisible();
  // the navigator lives on the same page, not behind another tab
  await page.getByText("BROWSE THE FILES").click();
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Vault folders" })).toBeVisible();
});

test("vault tab (Phase V chrome): the reskinned chrome frames BOTH the real 3D map and the file navigator", async ({ page }) => {
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  // the 3D knowledge-map region is present (the real graph — NOT the mockup's
  // static SVG placeholder), with its canvas painted
  await expect(page.getByRole("region", { name: "Vault map" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 20_000 });
  // and the file navigator lives on the same page, a scroll below
  await page.getByText("BROWSE THE FILES").click();
  await expect(page.getByRole("region", { name: "Vault files" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Vault folders" })).toBeVisible();
});

test("system tab: health, scheduled jobs, org chart and activity live as sub-tabs", async ({ page }) => {
  await page.getByRole("button", { name: "System", exact: true }).click();
  for (const sub of ["Health", "Scheduled jobs", "Org chart", "Activity & checks"]) {
    await expect(page.getByRole("button", { name: sub })).toBeVisible();
  }
  await page.getByRole("button", { name: "Org chart" }).click();
  await expect(page.getByText("ORDERS FLOW DOWN · TRUTH FLOWS UP")).toBeVisible();
  await page.getByRole("button", { name: "Activity & checks" }).click();
  await expect(page.getByText("System smoke test")).toBeVisible();
});

test("work pill + drawer: background work rides the sidebar; a failure names itself and offers details + dismiss", async ({ page }) => {
  // CALIBRATED INSTRUMENT (2026-07-17): the docked tray is now a work PILL in
  // the sidebar foot that opens a FIXED overlay drawer. Fixtures serve one
  // running check (progress bar), one blocked check, one staged-waiting pack
  // and one completed send (the log).
  const bar = page.getByRole("navigation", { name: "Console navigation" });
  // the pill names the live counts and rides every view (it is shell chrome)
  const pill = bar.getByRole("button", { name: "Background work: 1 running, 1 failed" });
  await expect(pill).toBeVisible();
  await pill.click();
  const drawer = page.getByRole("dialog", { name: "Background work" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/1 running/)).toBeVisible();
  await expect(drawer.getByText(/1 failed/)).toBeVisible();
  await expect(drawer.getByText(/1 waiting on you/)).toBeVisible();
  await expect(drawer.getByText(/1 done/)).toBeVisible();
  // running work fills a bar; finished work stays as a log entry with its outcome
  await expect(drawer.getByRole("progressbar")).toBeVisible();
  await expect(drawer.getByText("Done", { exact: true })).toBeVisible();
  await expect(drawer.getByText(/23 of 23 delivered/)).toBeVisible();
  // the failure speaks plainly and carries its own controls
  await expect(drawer.getByText("Blocked — nothing was staged or sent.")).toBeVisible();
  await drawer.getByRole("button", { name: "Show details" }).click();
  await expect(drawer.getByText(/orion-me\.example\.com/)).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Dismiss" }).first()).toBeVisible();
  // the staged pack states the human gap honestly
  await expect(drawer.getByText("Checks passed. Nothing sends until you confirm.")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Open send screen" })).toBeVisible();
  // Escape closes the overlay; the pill still rides another view
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(pill).toBeVisible();
});

test("work drawer overlays the page — opening it does not reflow the content", async ({ page }) => {
  // the drawer is position:fixed (never a flex sibling): the main content keeps
  // its geometry whether the drawer is open or shut.
  const main = page.locator("main.app-main");
  const shut = await main.boundingBox();
  const pill = page.getByRole("button", { name: /^Background work:/ });
  await pill.click();
  await expect(page.getByRole("dialog", { name: "Background work" })).toBeVisible();
  const open = await main.boundingBox();
  expect(open?.width).toBeCloseTo(shut?.width ?? 0, 0);
  expect(open?.x).toBeCloseTo(shut?.x ?? 0, 0);
  // and no horizontal page overflow while the overlay is up
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("sidebar collapses to an off-canvas slide-over on a phone; no horizontal page scroll at 390", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  // <=760: the rail is off-canvas behind a slim top bar with a burger
  const burger = page.getByRole("button", { name: "Open navigation" });
  await expect(burger).toBeVisible();
  // the page never scrolls sideways at phone width
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "page overflows horizontally at 390px").toBeLessThanOrEqual(0);
  // the burger slides the nav in; every view stays reachable
  await burger.click();
  const bar = page.getByRole("navigation", { name: "Console navigation" });
  const sys = bar.getByRole("button", { name: "System", exact: true });
  await expect(sys).toBeVisible();
  await sys.click();
  // navigating from the slide-over keeps the phone layout intact (no sideways scroll)
  const after = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(after, "page overflows horizontally after mobile nav at 390px").toBeLessThanOrEqual(0);
});
