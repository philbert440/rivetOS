/**
 * file_read tool tests
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileReadTool } from './file-read.js';

const TEST_DIR = join(tmpdir(), `rivetos-file-read-test-${Date.now()}`);

describe('file_read', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'hello.txt'), 'line one\nline two\nline three\nline four\nline five\n');
    writeFileSync(join(TEST_DIR, 'empty.txt'), '');
    writeFileSync(join(TEST_DIR, 'no-trailing-newline.txt'), 'hello\nworld');
    // Binary file: write some null bytes
    const binBuf = Buffer.alloc(100);
    binBuf[50] = 0;
    binBuf.write('not all text', 0);
    writeFileSync(join(TEST_DIR, 'binary.bin'), binBuf);
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('reads a file with line numbers', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute({ path: join(TEST_DIR, 'hello.txt') });
    assert.ok(result.includes('1 | line one'));
    assert.ok(result.includes('5 | line five'));
  });

  it('reads a file without line numbers', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute({ path: join(TEST_DIR, 'hello.txt'), line_numbers: false });
    assert.ok(!result.includes(' | '));
    assert.ok(result.includes('line one'));
  });

  it('reads a line range', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute({ path: join(TEST_DIR, 'hello.txt'), start_line: 2, end_line: 4 });
    assert.ok(result.includes('line two'));
    assert.ok(result.includes('line four'));
    assert.ok(!result.includes('line one'));
    assert.ok(!result.includes('line five'));
  });

  it('detects binary files', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute({ path: join(TEST_DIR, 'binary.bin') });
    assert.ok(result.includes('Binary file'));
  });

  it('returns error for missing file', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute({ path: join(TEST_DIR, 'nope.txt') });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('not found'));
  });

  it('respects max file size', async () => {
    const tool = createFileReadTool({ maxFileSize: 10 }); // 10 bytes
    const result = await tool.execute({ path: join(TEST_DIR, 'hello.txt') });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('exceeds'));
  });

  it('handles empty files', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute({ path: join(TEST_DIR, 'empty.txt') });
    assert.equal(result, '');
  });

  it('handles file without trailing newline', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute({ path: join(TEST_DIR, 'no-trailing-newline.txt') });
    assert.ok(result.includes('hello'));
    assert.ok(result.includes('world'));
  });

  it('resolves relative path from workingDir context', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute({ path: 'hello.txt' }, undefined, { workingDir: TEST_DIR });
    assert.ok(result.includes('line one'));
  });

  it('returns error for start_line beyond file length', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute({ path: join(TEST_DIR, 'hello.txt'), start_line: 100 });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('exceeds'));
  });

  it('returns error for empty path', async () => {
    const tool = createFileReadTool();
    const result = await tool.execute({ path: '' });
    assert.ok(result.includes('Error'));
  });

  it('has correct tool metadata', () => {
    const tool = createFileReadTool();
    assert.equal(tool.name, 'file_read');
    assert.ok(tool.description.length > 0);
    assert.equal((tool.parameters as any).type, 'object');
    assert.ok((tool.parameters as any).required.includes('path'));
  });
});
