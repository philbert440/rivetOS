import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAMILY_SITES, LEGACY_DOCS, familySite } from './family.mjs';
import { REPO_ROOT } from './assets.mjs';

const node = process.execPath;

function htmlFiles(distDir) {
  return readdirSync(distDir).filter((name) => name.endsWith('.html'));
}

function readDist(siteId, file) {
  return readFileSync(join(REPO_ROOT, familySite(siteId).distDir, file), 'utf8');
}

function assertNoRedirectToLegacy(html, file) {
  assert.doesNotMatch(html, /http-equiv=["']refresh/i, file);
  assert.doesNotMatch(html, /<link rel="canonical" href="https:\/\/rivetos\.dev/i, file);
  assert.doesNotMatch(html, /location\s*=\s*['"]https:\/\/rivetos\.dev/i, file);
  assert.doesNotMatch(html, /window\.location\.replace\(\s*['"]https:\/\/rivetos\.dev/i, file);
}

describe('family site builds', () => {
  for (const site of FAMILY_SITES) {
    execFileSync(node, [join(REPO_ROOT, site.buildScript)], { cwd: REPO_ROOT, stdio: 'pipe' });
  }

  it('writes three separate dist directories with matching canonical origins', () => {
    for (const site of FAMILY_SITES) {
      const dist = join(REPO_ROOT, site.distDir);
      assert.equal(existsSync(join(dist, 'index.html')), true, site.distDir);
      const home = readFileSync(join(dist, 'index.html'), 'utf8');
      assert.match(home, new RegExp(`<link rel="canonical" href="${site.origin}/"`), site.id);
      assert.match(home, new RegExp(`class="family-bar"`), site.id);
      assert.match(home, /href="https:\/\/rivethub\.io\/"/, site.id);
      assert.match(home, /href="https:\/\/rivethub\.org\/"/, site.id);
      assert.match(home, /href="https:\/\/rivethub\.dev\/"/, site.id);
    }
    assert.notEqual(familySite('io').distDir, familySite('org').distDir);
    assert.notEqual(familySite('org').distDir, familySite('dev').distDir);
  });

  it('keeps product download, install, support, privacy, and releases pages on rivethub.io', () => {
    const dist = join(REPO_ROOT, familySite('io').distDir);
    for (const name of [
      'index.html',
      'install-local.html',
      'apps.html',
      'support.html',
      'privacy.html',
      'releases.html',
    ]) {
      assert.equal(existsSync(join(dist, name)), true, name);
      const html = readFileSync(join(dist, name), 'utf8');
      assert.match(html, /<link rel="canonical" href="https:\/\/rivethub\.io\//, name);
      assert.match(html, /class="family-bar"/, name);
    }
  });

  it('lists real in-repo plugins on .org and labels proposals', () => {
    const plugins = readDist('org', 'plugins.html');
    assert.match(plugins, /@rivetos\/tool-shell/);
    assert.match(plugins, /plugins\/tools\/shell/);
    const starters = readDist('org', 'starters.html');
    assert.match(starters, /Proposal/);
    assert.match(starters, /npx nx g @rivetos\/nx:plugin --type=channel --name=slack/);
    assert.match(starters, /workspace-templates/);
    const contribute = readDist('org', 'contribute.html');
    assert.match(contribute, /DRAFT/);
    assert.match(contribute, /CONTRIBUTING.md/);
  });

  it('keeps rivethub.dev independent of rivetos.dev', () => {
    const dist = join(REPO_ROOT, familySite('dev').distDir);
    for (const name of htmlFiles(dist)) {
      const html = readFileSync(join(dist, name), 'utf8');
      assert.match(html, /<link rel="canonical" href="https:\/\/rivethub\.dev\//, name);
      assertNoRedirectToLegacy(html, name);
    }
    const home = readDist('dev', 'index.html');
    assert.match(home, /separate static build/);
    assert.match(home, /npx rivetos local/);
    const contrib = readDist('dev', 'contributing.html');
    assert.match(contrib, /npm run ci/);
    const plug = readDist('dev', 'plugins.html');
    assert.match(plug, /Depend on @rivetos\/types only/);
    assert.match(plug, /npx rivetos plugin init/);
    const policies = readDist('dev', 'policies.html');
    assert.match(policies, /DRAFT \/ PROPOSED/);
    assert.match(policies, /Apache License 2.0/);
  });

  it('leaves apps/site pointed at rivetos.dev', () => {
    const astro = readFileSync(join(REPO_ROOT, LEGACY_DOCS.astroConfig), 'utf8');
    assert.match(astro, /site:\s*'https:\/\/rivetos\.dev'/);
    const redirects = astro.slice(astro.indexOf('redirects'), astro.indexOf('integrations'));
    assert.doesNotMatch(redirects, /rivethub\.dev/);
    assert.doesNotMatch(redirects, /https:\/\/rivetos\.dev/);
  });
});

describe('io landing still names the ownership sections', () => {
  it('keeps the public FAQ copy after the docs split', () => {
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../rivethub-site/public/index.html'),
      'utf8',
    );
    assert.match(html, /Your agents/);
    assert.match(html, /rivetos\.dev/);
    assert.match(html, /rivethub\.dev/);
  });
});
