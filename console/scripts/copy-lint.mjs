#!/usr/bin/env node
// copy-lint — COCKPIT-V4 §11.5 ban-list over the console source.
// Bans console-speak from user-facing code. Exemptions:
//   • prose.ts — the repair layer necessarily NAMES the banned phrases in its rules
//   • *.bak* siblings, tests/, node_modules
//   • comments (stripped before matching) — not user-facing
//   • src/app/api/** for machine-param terms (sendUpdates is a real API param)
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "src");
const SCAN = ["components", "app"].map((d) => path.join(ROOT, d));

// [regex, description, componentsOnly]
const BANS = [
  [/\bball\s+(theirs|ours)\b/i, "'ball theirs/ours' — say 'their move' / 'our move'", false],
  [/\bcadence-exhausted\b/i, "'cadence-exhausted' — say 'finished the outreach ladder'", false],
  [/\bboard truth\b/i, "'board truth' — internal machinery name", false],
  [/\bin limbo\b/i, "'in limbo' — say 'rescheduling — old date cancelled'", false],
  [/\bmint link\b/i, "'mint link' — say 'create Meet link'", false],
  [/\bsend-GO\b/, "'send-GO' — say 'when you approve the send'", false],
  [/\(count only\)/i, "'(count only)' — render real rows or a real sentence", false],
  [/(?<![\w.])Certified\b/, "'Certified' — say 'Data checked'", true],
  [/\bsendUpdates\b/, "'sendUpdates' — Google API param leaking into UI copy", true],
  [/\(\d+\s*bd\b|\b\d+\s*bd\s+quiet\b/i, "'Nbd' shorthand — spell out 'N business days'", true],
  [/[🔴🧊🟠✅❌]/u, "emoji bullet — monochrome glyphs only", true],
  [/licitacion(?![\p{L}])/u, "unaccented 'licitacion' — display copy uses 'licitación'", true],
];

// prose.ts and labels.ts are the repair layers — they NAME banned strings in
// their fix rules; that is their job, not a leak.
const EXEMPT = [/prose\.ts$/, /cockpit[\\/]labels\.ts$/, /\.bak/, /node_modules/, /tests\//];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

// strip // line comments and /* */ blocks — comments aren't user-facing copy
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n").map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    }).join("\n");
}

let bad = 0;
for (const scanRoot of SCAN) {
  const isComponents = scanRoot.endsWith("components");
  for (const f of walk(scanRoot)) {
    if (EXEMPT.some((rx) => rx.test(f))) continue;
    const isApi = f.includes(`${path.sep}api${path.sep}`);
    const lines = stripComments(fs.readFileSync(f, "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const [rx, why, componentsOnly] of BANS) {
        if (componentsOnly && (!isComponents || isApi)) continue;
        if (rx.test(line)) {
          console.error(`✗ ${path.relative(process.cwd(), f)}:${i + 1} — ${why}\n    ${line.trim().slice(0, 120)}`);
          bad++;
        }
      }
      // §3.2 rule: reading-size text may never be ink-faint (contrast floor).
      // Extended 2026-07-17 (CALIBRATED INSTRUMENT port): the ban now covers
      // caption and micro too — the whole readable scale. ink-faint is reserved
      // for non-text (hairlines, decorative glyphs); readable copy uses ink-dim.
      // placeholder text is an input affordance, not content — allowed at faint.
      const noPlaceholder = line.replace(/placeholder:text-ink-faint/g, "");
      if (isComponents && /text-(body|caption|micro)[^"'`]*ink-faint|ink-faint[^"'`]*text-(body|caption|micro)/.test(noPlaceholder)) {
        console.error(`✗ ${path.relative(process.cwd(), f)}:${i + 1} — reading-size text (body/caption/micro) + ink-faint co-occurrence (contrast floor §3.2)\n    ${line.trim().slice(0, 120)}`);
        bad++;
      }
    });
  }
}
if (bad) { console.error(`\ncopy-lint: ${bad} violation(s)`); process.exit(1); }
console.log("copy-lint: clean");
