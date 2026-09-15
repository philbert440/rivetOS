import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  posthogCacheDigest,
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

function leakyPayload() {
  return {
    $current_url: 'https://rivethub.io/apps.html?utm_source=alice%40example.com',
    $initial_current_url: 'https://rivethub.io/?ref=newsletter#welcome',
    $referrer: 'https://mail.example/c?email=a@b.com',
    $initial_referrer: 'https://rivetos.dev/privacy/?utm=1',
    $session_entry_url: 'https://rivethub.io/support.html?email=a@b.com',
    $session_entry_referrer: 'https://mail.example/c?email=a@b.com',
    utm_source: 'alice@example.com',
    $session_entry_utm_source: 'alice@example.com',
    $initial_utm_source: 'alice@example.com',
    gclid: 'abc',
    $session_entry_gclid: 'alice@example.com',
    $pathname: '/apps.html',
    $set_once: { $initial_utm_source: 'alice@example.com' },
  };
}

const cleanPayload = {
  $current_url: 'https://rivethub.io/apps.html',
  $initial_current_url: 'https://rivethub.io/',
  $referrer: 'https://mail.example/c',
  $initial_referrer: 'https://rivetos.dev/privacy/',
  $session_entry_url: 'https://rivethub.io/support.html',
  $session_entry_referrer: 'https://mail.example/c',
  $pathname: '/apps.html',
  $set_once: {},
};

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

  it('drops campaign fields and sanitizes session-entry referrer', () => {
    assert.deepEqual(sanitizeAnalyticsProperties(leakyPayload()), cleanPayload);
  });
});

describe('posthog cache digest', () => {
  it('changes when a local .env key is rotated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'posthog-cache-'));
    try {
      writeFileSync(join(dir, '.env'), 'PUBLIC_POSTHOG_KEY=phc_a\n');
      const first = posthogCacheDigest(dir, {});
      writeFileSync(join(dir, '.env'), 'PUBLIC_POSTHOG_KEY=phc_b\n');
      const second = posthogCacheDigest(dir, {});
      writeFileSync(join(dir, '.env'), 'PUBLIC_POSTHOG_KEY=\n');
      const empty = posthogCacheDigest(dir, {});
      assert.notEqual(first, second);
      assert.notEqual(second, empty);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CLI digest follows the project .env, not the process env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'posthog-cache-cli-'));
    const script = join(dirname(fileURLToPath(import.meta.url)), 'posthog-cache-key.mjs');
    try {
      writeFileSync(join(dir, '.env'), 'PUBLIC_POSTHOG_KEY=phc_cli\n');
      const printed = execFileSync(process.execPath, [script, dir, 'hub'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      }).trim();
      assert.equal(printed, posthogCacheDigest(dir, {}));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function stubDocument() {
  const node = { parentNode: { insertBefore() {} } };
  return {
    createElement() {
      return { type: '', crossOrigin: '', async: false, src: '' };
    },
    getElementsByTagName() {
      return [node];
    },
  };
}

function runHubTracker(key) {
  const href = 'https://rivethub.io/apps.html?utm_source=alice%40example.com';
  const url = new URL(href);
  const captured = { init: null };
  const context = {
    window: { RIVET_POSTHOG_KEY: key, RIVET_POSTHOG_HOST: 'https://us.i.posthog.com' },
    location: {
      href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
    },
    document: stubDocument(),
    posthog: {
      init(k, opts) {
        captured.init = { key: k, opts };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(publicDir, 'posthog.js'), 'utf8'), context);
  return { context, captured };
}

function runAstroTracker(key) {
  const href = 'https://rivetos.dev/guides/getting-started/?utm_source=alice%40example.com';
  const url = new URL(href);
  const captured = { init: null };
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../site/src/components/PostHog.astro'),
    'utf8',
  );
  const match = src.match(/<script is:inline[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'PostHog.astro should contain an inline script');
  const context = {
    window: { __rivetPosthogBound: false, __rivetPosthogLastUrl: '' },
    location: {
      href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
    },
    document: {
      ...stubDocument(),
      addEventListener() {},
    },
    posthog: {
      init(k, opts) {
        captured.init = { key: k, opts };
      },
      capture() {},
    },
    key,
    host: 'https://us.i.posthog.com',
  };
  vm.createContext(context);
  vm.runInContext(match[1], context);
  return { context, captured };
}

describe('generated tracker snippets', () => {
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

  it('empty config stub plus tracker is a no-op', () => {
    const href = 'https://rivethub.io/privacy.html';
    const context = {
      window: {},
      location: { href, origin: 'https://rivethub.io', pathname: '/privacy.html', search: '' },
      document: stubDocument(),
      posthog: {
        init() {
          throw new Error('init must not run');
        },
      },
    };
    vm.createContext(context);
    vm.runInContext(
      readFileSync(join(publicDir, 'posthog-config.js'), 'utf8') +
        '\n' +
        readFileSync(join(publicDir, 'posthog.js'), 'utf8'),
      context,
    );
    assert.equal(context.window.__rivetPosthogBound, undefined);
  });

  it('Hub snippet drops utm_* and sanitizes session-entry referrer', () => {
    const { captured } = runHubTracker('phc_test');
    assert.equal(captured.init.key, 'phc_test');
    assert.equal(captured.init.opts.save_campaign_params, false);
    assert.deepEqual(captured.init.opts.sanitize_properties(leakyPayload()), cleanPayload);
  });

  it('Astro snippet drops utm_* and sanitizes session-entry referrer', () => {
    const { captured } = runAstroTracker('phc_test');
    assert.equal(captured.init.key, 'phc_test');
    assert.equal(captured.init.opts.save_campaign_params, false);
    assert.deepEqual(captured.init.opts.sanitize_properties(leakyPayload()), cleanPayload);
  });
});
