/**
 * file_edit tool tests
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileEditTool } from './file-edit.js';

const TEST_DIR = join(tmpdir(), `rivetos-file-edit-test-${Date.now()}`);

describe('file_edit', () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('replaces a unique string', async () => {
    const tool = createFileEditTool();
    const target = join(TEST_DIR, 'edit1.txt');
    writeFileSync(target, 'hello world\nfoo bar\nbaz qux\n');
    const result = await tool.execute({ path: target, old_string: 'foo bar', new_string: 'foo replaced' });
    assert.ok(result.includes('Edited'));
    assert.equal(readFileSync(target, 'utf-8'), 'hello world\nfoo replaced\nbaz qux\n');
  });

  it('shows context snippet after edit', async () => {
    const tool = createFileEditTool();
    const target = join(TEST_DIR, 'edit-context.txt');
    writeFileSync(target, 'line1\nline2\nline3\nline4\nline5\nline6\nline7\n');
    const result = await tool.execute({ path: target, old_string: 'line4', new_string: 'REPLACED' });
    assert.ok(result.includes('REPLACED'));
    // Context should show nearby lines
    assert.ok(result.includes('line'));
  });

  it('fails when old_string not found', async () => {
    const tool = createFileEditTool();
    const target = join(TEST_DIR, 'edit-miss.txt');
    writeFileSync(target, 'hello world\n');
    const result = await tool.execute({ path: target, old_string: 'not here', new_string: 'nope' });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('not found'));
    // File should be unchanged
    assert.equal(readFileSync(target, 'utf-8'), 'hello world\n');
  });

  it('fails when old_string matches multiple times', async () => {
    const tool = createFileEditTool();
    const target = join(TEST_DIR, 'edit-ambiguous.txt');
    writeFileSync(target, 'foo\nbar\nfoo\nbaz\n');
    const result = await tool.execute({ path: target, old_string: 'foo', new_string: 'qux' });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('2 times'));
    // File should be unchanged
    assert.equal(readFileSync(target, 'utf-8'), 'foo\nbar\nfoo\nbaz\n');
  });

  it('returns error for missing file', async () => {
    const tool = createFileEditTool();
    const result = await tool.execute({ path: join(TEST_DIR, 'nope.txt'), old_string: 'a', new_string: 'b' });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('not found'));
  });

  it('returns error for empty old_string', async () => {
    const tool = createFileEditTool();
    const target = join(TEST_DIR, 'edit-empty.txt');
    writeFileSync(target, 'content\n');
    const result = await tool.execute({ path: target, old_string: '', new_string: 'new' });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('empty'));
  });

  it('handles multiline replacements', async () => {
    const tool = createFileEditTool();
    const target = join(TEST_DIR, 'edit-multi.txt');
    writeFileSync(target, 'start\nold line 1\nold line 2\nend\n');
    const result = await tool.execute({
      path: target,
      old_string: 'old line 1\nold line 2',
      new_string: 'new line 1\nnew line 2\nnew line 3',
    });
    assert.ok(result.includes('Edited'));
    assert.equal(readFileSync(target, 'utf-8'), 'start\nnew line 1\nnew line 2\nnew line 3\nend\n');
  });

  it('resolves relative path from workingDir', async () => {
    const tool = createFileEditTool();
    const target = join(TEST_DIR, 'edit-rel.txt');
    writeFileSync(target, 'before\n');
    const result = await tool.execute(
      { path: 'edit-rel.txt', old_string: 'before', new_string: 'after' },
      undefined,
      { workingDir: TEST_DIR },
    );
    assert.ok(result.includes('Edited'));
    assert.equal(readFileSync(target, 'utf-8'), 'after\n');
  });

  it('has correct tool metadata', () => {
    const tool = createFileEditTool();
    assert.equal(tool.name, 'file_edit');
    assert.ok(tool.description.length > 0);
    assert.ok((tool.parameters as any).required.includes('path'));
    assert.ok((tool.parameters as any).required.includes('old_string'));
    assert.ok((tool.parameters as any).required.includes('new_string'));
  });
});
