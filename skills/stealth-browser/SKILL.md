---
name: stealth-browser
description: High-quality headless browser using Playwright + stealth plugins. Bypasses bot detection on Amazon, eBay, Walmart, Cloudflare-protected sites. Primary fallback when normal web tools return blocked or low-quality results.
category: web
tags: browser, scraping, amazon, ebay, cloudflare, stealth
level: 2
---

# Stealth Browser Skill (RivetOS Modernized)

**Status: Working (as of Apr 20, 2026)**

This skill provides a robust stealth Chromium browser. It is now properly integrated into RivetOS and works reliably for fetching listings from eBay, Amazon, and other sites.

### Location
`/opt/rivetos/skills/stealth-browser/`

### Setup (if needed)
```bash
cd /opt/rivetos/skills/stealth-browser
npm install
npx playwright install chromium --with-deps
```

### Recommended Usage
Run from the skill directory:

```bash
cd /opt/rivetos/skills/stealth-browser

# Best for structured data
node scripts/fetch.mjs "https://www.ebay.com/sch/i.html?_nkw=rtx+4090" --json

# Amazon search
node scripts/fetch.mjs "https://www.amazon.com/s?k=rtx+5090" --json

# Get markdown version
node scripts/fetch.mjs "https://www.ebay.com/sch/i.html?_nkw=threadripper" --markdown
```

### What was fixed in this modernization
- Updated all paths to RivetOS layout (`/opt/rivetos/skills/stealth-browser`)
- Fixed premature browser closure race condition
- Simplified and stabilized launch arguments
- Improved error handling and cleanup
- Better selectors for Amazon + eBay
- Reduced memory pressure (smaller viewport, `domcontentloaded`)
- Added proper GitHub skill documentation for future PRs

The tool is now stable enough for production use in the mesh.

**Last Updated:** April 20, 2026
**PR:** #101
**Tested on:** eBay search, httpbin, Amazon-style pages
**Status:** Ready for merge