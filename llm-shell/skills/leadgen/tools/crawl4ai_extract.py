#!/usr/bin/env python3
"""Crawl4AI single-page contact extractor — token-light fallback for the orchestrator.

Why this exists
---------------
`scrape_contacts.py` (Scrapling) is the primary extractor. Some sites return an
empty body to Scrapling's HTTP/stealth tiers (heavy JS shells, aggressive bot
walls, SPA contact widgets). Crawl4AI renders the page in a real Chromium and
emits clean Markdown, which often surfaces the `ventas@`/`comercial@` role inbox
that Scrapling missed. This script is the orchestrator's fallback for exactly
those zero-email URLs.

Contract (identical to scrape_contacts.py so the orchestrator can treat them
interchangeably):
    stdout JSON: {"contacts": [{"email","domain","snippet","source_url"}],
                  "title": "<page title>", "engine": "crawl4ai"}
    on failure : {"error": "<reason>", "engine": "crawl4ai"}

The LLM never sees raw HTML — only the small extracted contact list + snippet,
same as the Scrapling path. Runs in /opt/crawl4ai-venv (where crawl4ai lives);
reuses scrape_contacts.extract_contacts so the email-skip rules stay in one place.

Usage:
    /opt/crawl4ai-venv/bin/python3 crawl4ai_extract.py <url>
"""

import asyncio
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


async def _markdown(url, timeout_s=60):
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig

    browser_cfg = BrowserConfig(verbose=False, headless=True)
    run_cfg = CrawlerRunConfig(verbose=False, page_timeout=timeout_s * 1000)
    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        res = await crawler.arun(url=url, config=run_cfg)
        if not getattr(res, "success", False):
            raise RuntimeError(getattr(res, "error_message", "crawl failed"))
        # Prefer fit/raw markdown; fall back to cleaned HTML text.
        md = getattr(res, "markdown", None)
        if md and not isinstance(md, str):  # crawl4ai MarkdownGenerationResult
            md = getattr(md, "fit_markdown", None) or getattr(md, "raw_markdown", "")
        return md or getattr(res, "cleaned_html", "") or ""


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: crawl4ai_extract.py <url>", "engine": "crawl4ai"}))
        return 2
    url = sys.argv[1]
    try:
        # Crawl4AI emits progress banners to stdout; keep stdout clean for our
        # JSON contract by routing everything during the crawl to stderr.
        with contextlib.redirect_stdout(sys.stderr):
            text = asyncio.run(_markdown(url))
    except Exception as e:  # noqa: BLE001 — surface any failure as the contract error
        print(json.dumps({"error": str(e)[:200], "engine": "crawl4ai"}))
        return 0

    contacts = extract_contacts(text, url)
    print(json.dumps({
        "contacts": contacts,
        "title": extract_title(text),
        "engine": "crawl4ai",
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
