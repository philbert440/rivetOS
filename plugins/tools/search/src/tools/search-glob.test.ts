/**
 * search_glob tool tests
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSearchGlobTool } from './search-glob.js';

const TEST_DIR = join(tmpdir(), `rivetos-search-glob-test-${Date.now()}`);

describe('search_glob', () => {
  beforeAll(() => {
    mkdirSync(join(TEST_DIR, 'src', 'utils'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'src', 'tools'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'src', 'index.ts'), 'export {};');
    writeFileSync(join(TEST_DIR, 'src', 'utils', 'helper.ts'), 'export {};');
    writeFileSync(join(TEST_DIR, 'src', 'tools', 'shell.ts'), 'export {};');
    writeFileSync(join(TEST_DIR, 'src', 'tools', 'shell.test.ts'), 'test');
    writeFileSync(join(TEST_DIR, 'README.md'), '# test');
    writeFileSync(join(TEST_DIR, 'node_modules', 'dep', 'index.js'), 'module.exports = {};');
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('finds files matching a pattern', async () => {
    const tool = createSearchGlobTool();
    const result = await tool.execute({ pattern: '**/*.ts' }, undefined, { workingDir: TEST_DIR });
    assert.ok(result.includes('index.ts'));
    assert.ok(result.includes('helper.ts'));
    assert.ok(result.includes('shell.ts'));
  });

  it('ignores node_modules by default', async () => {
    const tool = createSearchGlobTool();
    const result = await tool.execute({ pattern: '**/*.js' }, undefined, { workingDir: TEST_DIR });
    assert.ok(!result.includes('node_modules'));
  });

  it('returns no-match message when nothing found', async () => {
    const tool = createSearchGlobTool();
    const result = await tool.execute({ pattern: '**/*.xyz' }, undefined, { workingDir: TEST_DIR });
    assert.ok(result.includes('No files'));
  });

  it('respects maxResults', async () => {
    const tool = createSearchGlobTool({ maxResults: 2 });
    const result = await tool.execute({ pattern: '**/*.ts' }, undefined, { workingDir: TEST_DIR });
    assert.ok(result.includes('2+'));
  });

  it('accepts custom cwd in args', async () => {
    const tool = createSearchGlobTool();
    const result = await tool.execute({ pattern: '*.ts', cwd: join(TEST_DIR, 'src') });
    assert.ok(result.includes('index.ts'));
  });

  it('returns error for empty pattern', async () => {
    const tool = createSearchGlobTool();
    const result = await tool.execute({ pattern: '' });
    assert.ok(result.includes('Error'));
  });

  it('has correct tool metadata', () => {
    const tool = createSearchGlobTool();
    assert.equal(tool.name, 'search_glob');
    assert.ok(tool.description.length > 0);
    assert.ok((tool.parameters as any).required.includes('pattern'));
  });
});
