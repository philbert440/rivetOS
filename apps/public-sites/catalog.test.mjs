import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROPOSED_STARTERS, firstParagraph, scanCatalog, yamlIntro } from './catalog.mjs';

describe('catalog scanners', () => {
  it('reads plugins, examples, and integrations from a synthetic tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-catalog-'));
    mkdirSync(join(root, 'plugins/tools/fixture-shell'), { recursive: true });
    mkdirSync(join(root, 'plugins/tools/ignored'), { recursive: true });
    mkdirSync(join(root, 'docs/examples'), { recursive: true });
    mkdirSync(join(root, 'integrations/fixture/kit'), { recursive: true });
    writeFileSync(
      join(root, 'plugins/tools/fixture-shell/package.json'),
      JSON.stringify({
        name: '@rivetos/tool-fixture-shell',
        description: 'Synthetic shell tool for tests',
        rivetos: { type: 'tool', name: 'fixture-shell' },
      }),
    );
    writeFileSync(
      join(root, 'plugins/tools/ignored/package.json'),
      JSON.stringify({ name: 'not-a-plugin', description: 'no rivetos field' }),
    );
    writeFileSync(
      join(root, 'docs/examples/fixture.yaml'),
      '# Fixture example\n# One agent on a test host.\n\nruntime: {}\n',
    );
    writeFileSync(
      join(root, 'integrations/fixture/kit/README.md'),
      '# fixture kit\n\nSynthetic capture kit used only in tests.\n',
    );

    const catalog = await scanCatalog(root);
    assert.equal(catalog.plugins.length, 1);
    assert.equal(catalog.plugins[0].name, 'fixture-shell');
    assert.equal(catalog.plugins[0].summary, 'Synthetic shell tool for tests');
    assert.equal(catalog.examples.length, 1);
    assert.equal(catalog.examples[0].title, 'Fixture example');
    assert.match(catalog.examples[0].summary, /test host/);
    assert.equal(catalog.integrations.length, 1);
    assert.match(catalog.integrations[0].summary, /Synthetic capture kit/);
    assert.equal(catalog.proposals.length, PROPOSED_STARTERS.length);
    assert.ok(catalog.proposals.every((item) => item.status === 'proposal'));
    assert.equal(catalog.plugins.some((item) => item.path.includes('ignored')), false);
  });

  it('parses yaml comment headers and markdown first paragraphs', () => {
    assert.deepEqual(yamlIntro('# Title\n# More detail.\n\nfoo: 1\n'), {
      title: 'Title',
      summary: 'More detail.',
    });
    assert.equal(
      firstParagraph('# Heading\n\nHello world from the kit.\n\n## Next\n'),
      'Hello world from the kit.',
    );
  });
});
