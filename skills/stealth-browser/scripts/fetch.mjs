#!/usr/bin/env node
/**
 * Stealth browser fetch — playwright-extra + stealth plugin
 * Bypasses bot detection on Amazon, Walmart, and other protected sites.
 *
 * Usage:
 *   node fetch.mjs <url> [options]
 *
 * Options:
 *   --json              Output structured JSON (auto-extracts product data)
 *   --text              Output plain text (default)
 *   --screenshot <path> Save a screenshot
 *   --selector <css>    Wait for a specific element before extracting
 *   --wait <ms>         Extra wait after load (default: 3000)
 *   --timeout <ms>      Navigation timeout (default: 30000)
 *   --full-page         Screenshot full page (default: viewport only)
 *   --markdown          Output body as simplified markdown
 *
 * Exit codes:
 *   0 = success
 *   1 = error
 *   2 = captcha detected (page content still output)
 *
 * Examples:
 *   node fetch.mjs "https://amazon.com/s?k=circuit+breaker" --json
 *   node fetch.mjs "https://ebay.com/itm/123456" --json
 *   node fetch.mjs "https://example.com" --screenshot page.png
 *   node fetch.mjs "https://example.com" --text
 */

// Resolve modules from ~/stealth-browser where deps are installed
import { createRequire } from 'module';
const require = createRequire(new URL('file:///home/philbot/stealth-browser/package.json'));
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const args = process.argv.slice(2);
const url = args.find(a => a.startsWith('http'));
if (!url) {
  console.error('Usage: node fetch.mjs <url> [--json|--text|--markdown] [--screenshot path] [--selector css] [--wait ms]');
  process.exit(1);
}

const flagVal = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
};

const screenshotPath = flagVal('--screenshot');
const selector = flagVal('--selector');
const waitMs = parseInt(flagVal('--wait') || '3000', 10);
const timeout = parseInt(flagVal('--timeout') || '30000', 10);
const jsonOutput = args.includes('--json');
const markdownOutput = args.includes('--markdown');
const fullPage = args.includes('--full-page');

// Rotate user agents to avoid fingerprinting on repeated requests
const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
];

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1920,1080',
    ],
  });

  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: ua,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

  // Wait for a specific selector if provided, otherwise just wait
  if (selector) {
    await page.waitForSelector(selector, { timeout: timeout }).catch(() => {});
  }
  await page.waitForTimeout(waitMs);

  // Captcha detection (Amazon, Cloudflare, generic)
  const hasCaptcha = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    return text.includes('enter the characters you see below') ||
           text.includes('type the characters') ||
           text.includes('verify you are human') ||
           text.includes('checking your browser') ||
           !!document.querySelector('#captchacharacters') ||
           !!document.querySelector('.a-box-inner form[action*="validateCaptcha"]') ||
           !!document.querySelector('#challenge-running') ||
           !!document.querySelector('.cf-turnstile');
  });

  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage });
  }

  if (jsonOutput) {
    const title = await page.title();
    const pageUrl = page.url();

    const data = await page.evaluate(() => {
      const getText = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : null;
      };
      const getAttr = (sel, attr) => {
        const el = document.querySelector(sel);
        return el ? el.getAttribute(attr) : null;
      };
      const getAllText = (sel) => {
        return [...document.querySelectorAll(sel)].map(el => el.innerText.trim()).filter(Boolean);
      };

      // Amazon
      const amazon = {
        title: getText('#productTitle') || getText('#title'),
        price: getText('.a-price .a-offscreen') || getText('#priceblock_ourprice') ||
               getText('#priceblock_dealprice') || getText('.a-price-whole'),
        rating: getText('#acrPopover .a-icon-alt') || getText('.a-icon-alt'),
        reviews: getText('#acrCustomerReviewText'),
        availability: getText('#availability span'),
        image: getAttr('#landingImage', 'src') || getAttr('#imgBlkFront', 'src'),
        // Search results
        searchResults: getAllText('.s-result-item .a-text-normal').slice(0, 10),
      };

      // eBay
      const ebay = {
        title: getText('.x-item-title__mainTitle') || getText('#itemTitle'),
        price: getText('.x-price-primary span') || getText('#prcIsum'),
        condition: getText('.x-item-condition-value .ux-textspans'),
        seller: getText('.x-sellercard-atf__info__about-seller a'),
      };

      // Generic
      const generic = {
        title: getText('h1') || document.title,
        description: document.querySelector('meta[name="description"]')?.content || null,
        bodyPreview: (document.body?.innerText || '').slice(0, 5000),
      };

      return { amazon, ebay, generic };
    });

    console.log(JSON.stringify({ url: pageUrl, title, hasCaptcha, data }, null, 2));
  } else if (markdownOutput) {
    // Simplified markdown-ish output
    const content = await page.evaluate(() => {
      const walk = (node, depth = 0) => {
        let out = '';
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            const t = child.textContent.trim();
            if (t) out += t + ' ';
          } else if (child.nodeType === 1) {
            const tag = child.tagName;
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'NAV', 'FOOTER'].includes(tag)) continue;
            if (['H1','H2','H3','H4','H5','H6'].includes(tag)) {
              out += '\n' + '#'.repeat(parseInt(tag[1])) + ' ' + child.innerText.trim() + '\n';
            } else if (tag === 'P') {
              out += '\n' + child.innerText.trim() + '\n';
            } else if (tag === 'LI') {
              out += '\n- ' + child.innerText.trim();
            } else if (tag === 'A' && child.href) {
              out += `[${child.innerText.trim()}](${child.href}) `;
            } else {
              out += walk(child, depth + 1);
            }
          }
        }
        return out;
      };
      return walk(document.body).slice(0, 8000);
    });
    console.log(content);
  } else {
    // Plain text
    const text = await page.evaluate(() => document.body?.innerText || '');
    if (hasCaptcha) console.log('[CAPTCHA DETECTED]');
    const title = await page.title();
    console.log(`Title: ${title}\n---`);
    console.log(text.slice(0, 5000));
  }

  await browser.close();
  process.exit(hasCaptcha ? 2 : 0);
} catch (err) {
  console.error('Error:', err.message);
  if (browser) await browser.close();
  process.exit(1);
}
