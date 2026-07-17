#!/opt/camoufox-venv/bin/python3
"""Camoufox single-page contact extractor — Tier-3 fallback for the orchestrator.

Why this exists
---------------
Scrapling (Tier-1) and Crawl4AI (Tier-2) cover most pages. A residue of
distributor sites defeat both with aggressive fingerprint/bot walls (Cloudflare
JS challenges, headless-Chromium detection) and hide their `ventas@`/`comercial@`
role inbox behind that wall. Camoufox is an anti-detect Firefox (C++-level
fingerprint spoofing, real Firefox UA) that renders those pages, so the role
inbox finally surfaces. This is the orchestrator's last-resort fallback for
exactly those zero-email URLs.

Contract (identical to scrape_contacts.py / crawl4ai_extract.py so the
orchestrator can treat all three interchangeably):
    stdout JSON: {"contacts": [{"email","domain","snippet","source_url"}],
                  "title": "<page title>", "engine": "camoufox"}
    on failure : {"error": "<reason>", "engine": "camoufox"}

The LLM never sees raw HTML — only the small extracted contact list + snippet.
Runs in /opt/camoufox-venv (where camoufox lives); reuses
scrape_contacts.extract_contacts so the email-skip rules stay in one place.

Usage:
    /opt/camoufox-venv/bin/python3 camoufox_extract.py <url>
"""

import contextlib
import json
import sys
from pathlib import Path

THIS_DIR = Path(__file__).parent
sys.path.insert(0, str(THIS_DIR))

# scrape_contacts imports Scrapling only lazily inside fetch(); the module-level
# extract_contacts/extract_title are pure-stdlib, so importing here is safe even
# though this venv has no scrapling.
from scrape_contacts import extract_contacts, extract_title  # noqa: E402


def _render(url, timeout_s=60):
    # Camoufox ships a sync Playwright-compatible launcher. extract_contacts works
    # on raw HTML (same as the Scrapling path), so page.content() is the right input.
    from camoufox.sync_api import Camoufox

    with Camoufox(headless=True) as browser:
        page = browser.new_page()
        page.goto(url, timeout=timeout_s * 1000, wait_until="domcontentloaded")
        html = page.content()
    return html


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: camoufox_extract.py <url>", "engine": "camoufox"}))
        return 2
    url = sys.argv[1]
    try:
        # Keep stdout clean for the JSON contract; route any browser banner to stderr.
        with contextlib.redirect_stdout(sys.stderr):
            html = _render(url)
    except Exception as e:  # noqa: BLE001 — surface any failure as the contract error
        print(json.dumps({"error": str(e)[:200], "engine": "camoufox"}))
        return 0

    print(json.dumps({
        "contacts": extract_contacts(html, url),
        "title": extract_title(html),
        "engine": "camoufox",
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
