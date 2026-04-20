---
name: stealth-browser
description: High-quality headless browser using Playwright + stealth plugins. Bypasses bot detection on Amazon, eBay, Walmart, Cloudflare-protected sites, and other anti-bot platforms. Use this when normal websearch or web_fetch returns blocked, empty, or heavily degraded results (especially product listings and pricing).
category: web
tags: browser, scraping, amazon, ebay, cloudflare, stealth
level: 2
---

# Stealth Browser Skill

This skill provides a robust, stealthy Chromium browser based on **Playwright + playwright-extra + stealth plugin**. It is specifically designed to get clean, real data from sites that aggressively block automated tools.

### Purpose in RivetOS
- Primary fallback when `websearch` or `web_fetch` cannot retrieve usable Amazon/eBay listings or prices.
- Extracts structured product data (prices, availability, seller info, search results).
- Takes screenshots when needed for visual verification.
- Returns clean markdown or JSON.

**Current Location:** `/opt/rivetos/skills/stealth-browser/`

---

## Prerequisites

The skill requires Node.js dependencies to be installed in the skill directory.

**One-time setup (run if node_modules is missing):**
```bash
cd /opt/rivetos/skills/stealth-browser
npm install
npx playwright install chromium --with-deps
```

---

## Usage (Recommended)

All commands should be run from the skill directory:

```bash
cd /opt/rivetos/skills/stealth-browser
node scripts/fetch.mjs "<url>" [options]
```

### Common Commands

**Get structured JSON (best for Amazon/eBay):**
```bash
node scripts/fetch.mjs "https://www.amazon.com/s?k=rtx+5090" --json
```

**Get clean markdown:**
```bash
node scripts/fetch.mjs "https://www.ebay.com/sch/i.html?_nkw=used+threadripper" --markdown
```

**Take a screenshot:**
```bash
node scripts/fetch.mjs "https://www.amazon.com/dp/B0EXAMPLE" --screenshot /tmp/listing.png --full-page
```

---

## Options

| Flag                | Description                              | Default     |
|---------------------|------------------------------------------|-------------|
| `--json`            | Return rich structured data              | false       |
| `--markdown`        | Return cleaned markdown content          | false       |
| `--text`            | Return plain text (default)              | true        |
| `--screenshot <path>` | Save screenshot to this location       | none        |
| `--full-page`       | Capture full page instead of viewport    | false       |
| `--selector <css>`  | Wait for this element before extraction  | none        |
| `--wait <ms>`       | Additional wait time after load          | 4000        |
| `--timeout <ms>`    | Navigation timeout                       | 45000       |

---

## Exit Codes

- `0` — Success
- `1` — General error
- `2` — Captcha / heavy bot protection detected (content may still be returned)

---

## JSON Output Format (when using --json)

```json
{
  "success": true,
  "url": "final url after redirects",
  "title": "Page title",
  "hasCaptcha": false,
  "content": { ... },
  "data": {
    "amazon": { "title", "price", "rating", "availability", "searchResults": [...] },
    "ebay": { "title", "price", "condition", "seller", "shipping" },
    "generic": { "bodyPreview", "links" }
  },
  "screenshot": "/path/to/screenshot.png (if requested)"
}
```

---

## Modern RivetOS Integration Notes

- This skill is now the canonical stealth browser for Rivet.
- `internet_search` has been retired — use `websearch` first, then fall back to this skill when listings are blocked.
- The script has been updated to resolve modules from the correct `/opt/rivetos/skills/stealth-browser/` location.
- Works well with our current vLLM + memory setup.

**Next step after updating this file:** We should also update `scripts/fetch.mjs`, create a proper `package.json`, install dependencies, and test with real Amazon/eBay queries.

---

**Last Updated:** April 20, 2026
**Status:** Being modernized to RivetOS standards
