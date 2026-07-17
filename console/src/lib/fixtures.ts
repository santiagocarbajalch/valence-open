// Fixtures mode (COCKPIT-V4 §11.1): COCKPIT_FIXTURES=1 makes the data routes
// serve a frozen day from tests/fixtures/ instead of running the live engine.
// Deterministic input for the verification suite — visual/data assertions can
// never flake on live mailbox state.
import fs from "node:fs";
import path from "node:path";

const FIXTURES_DIR = path.join(process.cwd(), "tests/fixtures");

export function fixturesOn(): boolean {
  return process.env.COCKPIT_FIXTURES === "1";
}

export function fixture(name: string): unknown | null {
  if (!fixturesOn()) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf8"));
  } catch {
    return null;
  }
}
