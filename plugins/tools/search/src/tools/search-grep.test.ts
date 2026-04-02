/**
 * search_grep tool tests
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSearchGrepTool } from './search-grep.js';

const TEST_DIR = join(tmpdir(), `rivetos-search-grep-test-${Date.now()}`);

describe('search_grep', () => {
  before(() => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'src', 'index.ts'), 'const foo = "hello";\nconst bar = "world";\nexport { foo, bar };\n');
    writeFileSync(join(TEST_DIR, 'src', 'utils.ts'), 'export function greet() {\n  return "hello world";\n}\n');
    writeFileSync(join(TEST_DIR, 'README.md'), '# Hello World\n\nThis is a test project.\n');
    writeFileSync(join(TEST_DIR, 'node_modules', 'dep', 'index.js'), 'const hello = "should be excluded";\n');
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('finds matches in files', async () => {
    const tool = createSearchGrepTool();
    const result = await tool.execute({ pattern: 'hello' }, undefined, { workingDir: TEST_DIR });
    assert.ok(result.includes('hello'));
    assert.ok(result.includes('index.ts'));
  });

  it('excludes node_modules by default', async () => {
    const tool = createSearchGrepTool();
    const result = await tool.execute({ pattern: 'hello' }, undefined, { workingDir: TEST_DIR });
    assert.ok(!result.includes('node_modules'));
  });

  it('returns no-match message', async () => {
    const tool = createSearchGrepTool();
    const result = await tool.execute({ pattern: 'zzzznotfound' }, undefined, { workingDir: TEST_DIR });
    assert.ok(result.includes('No matches'));
  });

  it('supports case-insensitive search', async () => {
    const tool = createSearchGrepTool();
    const result = await tool.execute({ pattern: 'HELLO', case_insensitive: true }, undefined, { workingDir: TEST_DIR });
    assert.ok(result.includes('hello') || result.includes('Hello'));
  });

  it('supports fixed string search', async () => {
    const tool = createSearchGrepTool();
    const result = await tool.execute({ pattern: 'foo, bar', fixed_strings: true }, undefined, { workingDir: TEST_DIR });
    assert.ok(result.includes('foo, bar'));
  });

  it('supports include filter', async () => {
    const tool = createSearchGrepTool();
    const result = await tool.execute({ pattern: 'hello', include: '*.ts' }, undefined, { workingDir: TEST_DIR });
    assert.ok(result.includes('.ts'));
    assert.ok(!result.includes('README'));
  });

  it('searches a specific file', async () => {
    const tool = createSearchGrepTool();
    const result = await tool.execute(
      { pattern: 'Hello', path: join(TEST_DIR, 'README.md') },
    );
    assert.ok(result.includes('Hello'));
  });

  it('returns error for empty pattern', async () => {
    const tool = createSearchGrepTool();
    const result = await tool.execute({ pattern: '' });
    assert.ok(result.includes('Error'));
  });

  it('has correct tool metadata', () => {
    const tool = createSearchGrepTool();
    assert.equal(tool.name, 'search_grep');
    assert.ok(tool.description.length > 0);
    assert.ok((tool.parameters as any).required.includes('pattern'));
  });
});
