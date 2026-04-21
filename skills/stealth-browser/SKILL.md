---
name: stealth-browser
description: Fetch web pages that block bots (Amazon, Walmart, Cloudflare-protected sites) using headless Chromium with stealth anti-detection. Use when web_fetch fails with 403/503/captcha, when scraping product listings or prices, or when a site serves empty/blocked content to automated requests. NOT for sites that work fine with web_fetch — use web_fetch first, fall back to this skill.
---

# Stealth Browser

Headless Chromium with playwright-extra stealth plugin. Bypasses bot detection that blocks standard web_fetch (Amazon, Walmart, Cloudflare Turnstile, etc.).

## Prerequisites

Dependencies are installed at `~/stealth-browser/node_modules/`. The skill script resolves them from there.

If missing, install once:
```bash
cd ~/stealth-browser && npm install playwright-extra puppeteer-extra-plugin-stealth playwright
```

Playwright browsers (Chromium) must also be installed:
```bash
cd ~/stealth-browser && npx playwright install chromium --with-deps
```

## Usage

All commands run from the skill's scripts directory. Always use `--json` for structured extraction.

### Fetch a page as JSON (recommended)
```bash
node ~/.openclaw/skills/stealth-browser/scripts/fetch.mjs "https://amazon.com/s?k=circuit+breaker" --json
```

### Fetch as plain text
```bash
node ~/.openclaw/skills/stealth-browser/scripts/fetch.mjs "https://example.com"
```

### Fetch as simplified markdown
```bash
node ~/.openclaw/skills/stealth-browser/scripts/fetch.mjs "https://example.com" --markdown
```

### Take a screenshot
```bash
node ~/.openclaw/skills/stealth-browser/scripts/fetch.mjs "https://example.com" --screenshot /tmp/page.png [--full-page]
```

### Wait for a specific element
```bash
node ~/.openclaw/skills/stealth-browser/scripts/fetch.mjs "https://example.com" --json --selector "#productTitle" --wait 5000
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | Structured JSON with auto-extracted product data (Amazon, eBay) |
| `--text` | on | Plain text output (default) |
| `--markdown` | off | Simplified markdown output |
| `--screenshot <path>` | none | Save viewport screenshot |
| `--full-page` | off | Screenshot entire page (use with --screenshot) |
| `--selector <css>` | none | Wait for element before extraction |
| `--wait <ms>` | 3000 | Extra wait after page load |
| `--timeout <ms>` | 30000 | Navigation timeout |

## Exit Codes

- `0` — success
- `1` — error (network, timeout, etc.)
- `2` — captcha detected (content still output, but may be incomplete)

## JSON Output Structure

When using `--json`, output includes auto-extracted fields for known sites:

```json
{
  "url": "final URL after redirects",
  "title": "page title",
  "hasCaptcha": false,
  "data": {
    "amazon": { "title", "price", "rating", "reviews", "availability", "image", "searchResults" },
    "ebay": { "title", "price", "condition", "seller" },
    "generic": { "title", "description", "bodyPreview" }
  }
}
```

Use the appropriate site key. `generic.bodyPreview` contains first 5000 chars of body text for any site.

## Tips

- **Use `--json` for product pages** — auto-extracts prices, ratings, availability
- **Amazon search** works well: `https://amazon.com/s?k=search+terms`
- **Amazon product pages** use: `https://amazon.com/dp/ASIN`
- **If captcha detected** (exit code 2): retry once — stealth usually passes on second attempt
- **For very slow sites**: increase `--wait` to 5000-8000ms
- **NODE_PATH** must include the stealth-browser node_modules. The script resolves from `~/stealth-browser/`.
