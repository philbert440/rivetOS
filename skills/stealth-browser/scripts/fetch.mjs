#!/usr/bin/env node
/**
 * Stealth browser fetch — playwright-extra + stealth plugin (RivetOS fixed version)
 * Bypasses bot detection on Amazon, eBay, and other protected sites.
 */

import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

const args = process.argv.slice(2);
const url = args.find(a => a && a.startsWith('http'));
if (!url) {
  console.error('Usage: node fetch.mjs <url> [--json|--markdown]');
  process.exit(1);
}

const flagVal = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
};

const waitMs = parseInt(flagVal('--wait') || '3500', 10);
const timeout = parseInt(flagVal('--timeout') || '60000', 10);
const jsonOutput = args.includes('--json');
const markdownOutput = args.includes('--markdown');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

let browser = null;

try {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,720',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-zygote',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    locale: 'en-US',
    bypassCSP: true,
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
    delete window.cdc_keno;
  });

  console.log(`Navigating to: ${url}`);

  await page.goto(url, { 
    waitUntil: 'domcontentloaded', 
    timeout 
  });

  await page.waitForTimeout(waitMs);

  const hasCaptcha = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    return text.includes('captcha') || text.includes('robot') || 
           !!document.querySelector('iframe[src*="challenge"]') ||
           !!document.querySelector('.cf-turnstile');
  });

  const title = await page.title();
  console.log(`Title: ${title}`);

  if (jsonOutput) {
    const data = await page.evaluate(() => {
      const getText = (sel) => document.querySelector(sel)?.innerText.trim() || null;
      const getAll = (sel) => [...document.querySelectorAll(sel)].map(el => el.innerText.trim()).filter(Boolean);

      return {
        amazon: {
          title: getText('#productTitle') || getText('h1'),
          price: getText('.a-price .a-offscreen') || getText('#priceblock_ourprice'),
          searchResults: getAll('.s-result-item .a-text-normal').slice(0,6)
        },
        ebay: {
          title: getText('.x-item-title__mainTitle') || getText('h1'),
          price: getText('.x-price-primary') || getText('#prcIsum'),
          results: getAll('.s-item__title').slice(0,6)
        },
        generic: {
          bodyPreview: (document.body?.innerText || '').slice(0, 2500)
        }
      };
    });

    console.log(JSON.stringify({
      success: true,
      url: page.url(),
      title,
      hasCaptcha,
      data
    }, null, 2));
  } else {
    const text = await page.evaluate(() => document.body?.innerText || '');
    console.log('---');
    console.log(text.slice(0, 5000));
  }

  await browser.close();
  process.exit(0);

} catch (err) {
  console.error('Error:', err.message);
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
  process.exit(1);
}
