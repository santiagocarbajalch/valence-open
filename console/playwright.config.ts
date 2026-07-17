import { defineConfig } from "@playwright/test";

// Fixtures-mode smoke: a second `next start` on :4761 serving tests/fixtures
// through the real routes (COCKPIT_FIXTURES=1). Requires a prior `npm run build`.
export default defineConfig({
  testDir: "tests",
  timeout: 45_000,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:4761" },
  webServer: {
    command: "COCKPIT_FIXTURES=1 node_modules/.bin/next start -H 127.0.0.1 -p 4761",
    url: "http://127.0.0.1:4761",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
