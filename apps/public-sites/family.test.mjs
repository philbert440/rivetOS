import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAMILY_SITES, LEGACY_DOCS, canonicalUrl, familySite } from './family.mjs';
import { familyBarHtml, injectFamilyChrome } from './chrome.mjs';
import { REPO_ROOT } from './assets.mjs';

describe('family registry', () => {
  it('gives each family site its own domain, origin, nx project, and dist', () => {
    const ids = FAMILY_SITES.map((site) => site.id);
    assert.deepEqual(ids, ['io', 'org', 'dev']);
    const domains = new Set(FAMILY_SITES.map((site) => site.domain));
    const dists = new Set(FAMILY_SITES.map((site) => site.distDir));
    const projects = new Set(FAMILY_SITES.map((site) => site.nxProject));
    assert.equal(domains.size, 3);
    assert.equal(dists.size, 3);
    assert.equal(projects.size, 3);
    assert.equal(familySite('io').origin, 'https://rivethub.io');
    assert.equal(familySite('org').origin, 'https://rivethub.org');
    assert.equal(familySite('dev').origin, 'https://rivethub.dev');
    assert.equal(canonicalUrl(familySite('dev'), '/plugins.html'), 'https://rivethub.dev/plugins.html');
  });

  it('keeps legacy RivetOS docs on rivetos.dev and a different nx project', () => {
    assert.equal(LEGACY_DOCS.origin, 'https://rivetos.dev');
    assert.equal(LEGACY_DOCS.nxProject, 'site');
    assert.equal(LEGACY_DOCS.distDir, 'apps/site/dist');
    assert.ok(!FAMILY_SITES.some((site) => site.nxProject === 'site'));
    assert.ok(!FAMILY_SITES.some((site) => site.domain === 'rivetos.dev'));
  });

  it('does not retarget apps/site canonical to rivethub.dev', () => {
    const astro = readFileSync(join(REPO_ROOT, 'apps/site/astro.config.mjs'), 'utf8');
    assert.match(astro, /site:\s*'https:\/\/rivetos\.dev'/);
    assert.doesNotMatch(astro, /rivethub\.dev/);
    assert.doesNotMatch(astro, /https:\/\/rivetos\.dev\/['"]/);
  });
});

describe('family chrome', () => {
  it('marks the current site and links the other two origins', () => {
    const html = familyBarHtml('dev');
    assert.match(html, /aria-current="page">Developer docs/);
    assert.match(html, /href="https:\/\/rivethub\.io\/"/);
    assert.match(html, /href="https:\/\/rivethub\.org\/"/);
    assert.match(html, /href="https:\/\/rivethub\.dev\/"/);
    assert.doesNotMatch(html, /rivetos\.dev/);
  });

  it('injects the bar after a skip link on synthetic HTML', () => {
    const src = `<!doctype html><html><head><title>t</title></head><body><a class="skip-link" href="#main">Skip</a><main id="main">hi</main></body></html>`;
    const out = injectFamilyChrome(src, 'org');
    assert.match(out, /href="family.css"/);
    assert.match(out, /class="family-bar"/);
    assert.ok(out.indexOf('skip-link') < out.indexOf('family-bar'));
    assert.equal(injectFamilyChrome(out, 'org'), out);
  });
});
