/**
 * file_write tool tests
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileWriteTool } from './file-write.js';

const TEST_DIR = join(tmpdir(), `rivetos-file-write-test-${Date.now()}`);

describe('file_write', () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates a new file', async () => {
    const tool = createFileWriteTool();
    const target = join(TEST_DIR, 'new.txt');
    const result = await tool.execute({ path: target, content: 'hello world' });
    assert.ok(result.includes('Created'));
    assert.ok(result.includes('11 bytes'));
    assert.equal(readFileSync(target, 'utf-8'), 'hello world');
  });

  it('overwrites an existing file', async () => {
    const tool = createFileWriteTool();
    const target = join(TEST_DIR, 'overwrite.txt');
    writeFileSync(target, 'old content');
    const result = await tool.execute({ path: target, content: 'new content' });
    assert.ok(result.includes('Updated'));
    assert.equal(readFileSync(target, 'utf-8'), 'new content');
  });

  it('creates backup when requested', async () => {
    const tool = createFileWriteTool();
    const target = join(TEST_DIR, 'backup.txt');
    writeFileSync(target, 'original');
    const result = await tool.execute({ path: target, content: 'replaced', backup: true });
    assert.ok(result.includes('backup'));
    assert.equal(readFileSync(target, 'utf-8'), 'replaced');
    assert.equal(readFileSync(target + '.bak', 'utf-8'), 'original');
  });

  it('auto-creates parent directories', async () => {
    const tool = createFileWriteTool();
    const target = join(TEST_DIR, 'deep', 'nested', 'dir', 'file.txt');
    const result = await tool.execute({ path: target, content: 'deep' });
    assert.ok(result.includes('Created'));
    assert.equal(readFileSync(target, 'utf-8'), 'deep');
  });

  it('handles UTF-8 content', async () => {
    const tool = createFileWriteTool();
    const target = join(TEST_DIR, 'unicode.txt');
    const content = '你好世界 🌍 café';
    await tool.execute({ path: target, content });
    assert.equal(readFileSync(target, 'utf-8'), content);
  });

  it('resolves relative path from workingDir', async () => {
    const tool = createFileWriteTool();
    const result = await tool.execute({ path: 'relative.txt', content: 'test' }, undefined, { workingDir: TEST_DIR });
    assert.ok(result.includes('Created'));
    assert.ok(existsSync(join(TEST_DIR, 'relative.txt')));
  });

  it('returns error for empty path', async () => {
    const tool = createFileWriteTool();
    const result = await tool.execute({ path: '', content: 'nope' });
    assert.ok(result.includes('Error'));
  });

  it('has correct tool metadata', () => {
    const tool = createFileWriteTool();
    assert.equal(tool.name, 'file_write');
    assert.ok(tool.description.length > 0);
    assert.ok((tool.parameters as any).required.includes('path'));
    assert.ok((tool.parameters as any).required.includes('content'));
  });
});
