import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  renderPosthogConfig,
  resolvePosthogEnv,
  sanitizeAnalyticsProperties,
  sanitizeAnalyticsUrl,
} from './posthog-env.mjs';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');

describe('resolvePosthogEnv', () => {
  it('stays empty when no key is set', () => {
    assert.deepEqual(resolvePosthogEnv({}), {
      key: '',
      host: 'https://us.i.posthog.com',
    });
  });

  it('prefers PUBLIC_ over the Next.js house names', () => {
    assert.deepEqual(
      resolvePosthogEnv({
        PUBLIC_POSTHOG_KEY: ' phc_site ',
        NEXT_PUBLIC_POSTHOG_KEY: 'phc_next',
        PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com',
      }),
      { key: 'phc_site', host: 'https://eu.i.posthog.com' },
    );
  });

  it('falls back to NEXT_PUBLIC_* when PUBLIC_* is unset', () => {
    assert.deepEqual(
      resolvePosthogEnv({
        NEXT_PUBLIC_POSTHOG_KEY: 'phc_next',
        NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com',
      }),
      { key: 'phc_next', host: 'https://eu.i.posthog.com' },
    );
  });
});

describe('renderPosthogConfig', () => {
  it('JSON-encodes values so a quoted secret cannot break out of the script', () => {
    const js = renderPosthogConfig({
      key: 'phc_"x',
      host: 'https://us.i.posthog.com',
    });
    assert.equal(
      js,
      'window.RIVET_POSTHOG_KEY = "phc_\\"x";\nwindow.RIVET_POSTHOG_HOST = "https://us.i.posthog.com";\n',
    );
  });
});

describe('marketing pages load the gated snippet', () => {
  it('includes posthog scripts on every HTML page', () => {
    const pages = readdirSync(publicDir).filter((name) => name.endsWith('.html'));
    assert.ok(pages.length >= 9, 'expected the static marketing pages');
    for (const name of pages) {
      const html = readFileSync(join(publicDir, name), 'utf8');
      assert.match(html, /posthog-config\.js/, name);
      assert.match(html, /posthog\.js/, name);
    }
  });

  it('ships an empty public config stub so unbaked previews stay off', () => {
    const stub = readFileSync(join(publicDir, 'posthog-config.js'), 'utf8');
    assert.match(stub, /RIVET_POSTHOG_KEY = ''/);
  });
});

describe('sanitizeAnalyticsUrl', () => {
  it('drops query and hash that can carry email or tokens', () => {
    assert.equal(
      sanitizeAnalyticsUrl(
        'https://rivethub.io/privacy.html?email=a@b.com#token=secret',
      ),
      'https://rivethub.io/privacy.html',
    );
  });

  it('keeps origin and path on a docs page with a search string', () => {
    assert.equal(
      sanitizeAnalyticsUrl('https://rivetos.dev/guides/getting-started/?q=1'),
      'https://rivetos.dev/guides/getting-started/',
    );
  });
});

describe('sanitizeAnalyticsProperties', () => {
  it('strips query and hash from pageview and pageleave URL fields', () => {
    assert.deepEqual(
      sanitizeAnalyticsProperties({
        $current_url: 'https://rivethub.io/apps.html?email=a@b.com',
        $initial_current_url: 'https://rivethub.io/?ref=newsletter#welcome',
        $referrer: 'https://mail.example/c?email=a@b.com',
        $initial_referrer: 'https://rivetos.dev/privacy/?utm=1',
        $session_entry_url: 'https://rivethub.io/support.html?email=a@b.com',
        $pathname: '/apps.html',
      }),
      {
        $current_url: 'https://rivethub.io/apps.html',
        $initial_current_url: 'https://rivethub.io/',
        $referrer: 'https://mail.example/c',
        $initial_referrer: 'https://rivetos.dev/privacy/',
        $session_entry_url: 'https://rivethub.io/support.html',
        $pathname: '/apps.html',
      },
    );
  });
});

describe('trackers sanitize URL properties before they leave the page', () => {
  const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '../../site');
  const sources = [
    join(publicDir, 'posthog.js'),
    join(siteRoot, 'src/components/PostHog.astro'),
  ];

  it('registers sanitize_properties and does not send location.search', () => {
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      assert.match(src, /sanitize_properties/, file);
      assert.doesNotMatch(src, /location\.search/, file);
    }
  });
});
