// Scripted demo capture of the Valence console (public showcase).
//
// Records a ~30s narrated-by-motion tour of the three fixtures-backed tabs —
// Today, Pipeline, Scraping — and nothing else (Vault/Valence/System are never
// opened; they have no fixtures and would render empty off-VPS).
//
// Prereqs: `npm run build`, then a fixtures server:
//   COCKPIT_FIXTURES=1 node_modules/.bin/next start -H 127.0.0.1 -p <PORT>
// Run:  BASE=http://127.0.0.1:4791 OUT=<dir> node tests/demo-tour.mjs
// Everything on screen is synthetic (all *.example.com).
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:4791";
const OUT = process.env.OUT || "/tmp/demo-out";
const W = 1280, H = 800;

const sleep = (p) => p.waitForTimeout.bind(p);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});
const page = await ctx.newPage();
const pause = (ms) => page.waitForTimeout(ms);

// smooth-ish cursor glide before a click so the motion reads as deliberate
async function glide(sel) {
  const el = typeof sel === "string" ? page.locator(sel) : sel;
  const box = await el.boundingBox();
  if (!box) return el;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  for (let i = 1; i <= 6; i++) await page.mouse.move(x, y, { steps: 1 }).then(() => pause(20));
  return el;
}

async function wheel(dy, steps = 8) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy / steps); await pause(60); }
}

// ---- open ----------------------------------------------------------------
await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByText("They're waiting on you").first().waitFor({ timeout: 20_000 });
await pause(2400);

// ---- TODAY: open a company thread ---------------------------------------
// the board auto-selects the first company; click another to show a thread
// opening under the reply desk.
const row = page.getByRole("button", { name: /qa-fixture@example\.com/ }).first();
await glide(row);
await pause(300);
await row.click();
await pause(2200);
// let the conversation breathe, then scroll it a touch
await page.mouse.move(W * 0.72, H * 0.6);
await wheel(280, 6);
await pause(2000);

// ---- PIPELINE: the whole field, then expand a section --------------------
const toPipeline = page.getByRole("button", { name: "Pipeline", exact: true });
await glide(toPipeline);
await toPipeline.click();
await page.getByRole("heading", { name: "Pipeline" }).waitFor({ timeout: 10_000 });
await pause(2200);
// scroll to the collapsed "heavy" sections at the foot of Your move
await page.mouse.move(W * 0.55, H * 0.6);
await wheel(620, 9);
await pause(900);
// expand the Cold ladder section inline
const ladder = page.getByRole("button", { name: /Cold ladder/ }).first();
await glide(ladder);
await ladder.click();
await pause(2400);
await wheel(260, 5);
await pause(1800);

// ---- SCRAPING: the dig desk, then open a landed batch --------------------
const toScraping = page.getByRole("button", { name: "Scraping", exact: true });
await glide(toScraping);
await toScraping.click();
await page.getByRole("heading", { name: "Scraping" }).waitFor({ timeout: 10_000 });
await pause(2200);
await page.mouse.move(W * 0.5, H * 0.6);
await wheel(320, 6);
await pause(700);
// open one landed batch to reveal its per-company detail
const batch = page.getByRole("button", { name: /Lab equipment distributors . Brazil/ }).first();
await glide(batch);
await batch.click();
await pause(2400);
await wheel(220, 5);
await pause(2400);

await ctx.close(); // flushes the video
await browser.close();
console.log("tour done");
