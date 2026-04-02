/**
 * WorkspaceLoader tests — load, read, write, cache, system prompt, heartbeat prompt.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceLoader } from './workspace.js';

describe('WorkspaceLoader', () => {
  let tempDir: string;
  let loader: WorkspaceLoader;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rivetos-workspace-test-'));
    loader = new WorkspaceLoader(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('load()', () => {
    it('returns core files when they exist', async () => {
      await writeFile(join(tempDir, 'SOUL.md'), '# Soul');
      await writeFile(join(tempDir, 'IDENTITY.md'), '# Identity');
      await writeFile(join(tempDir, 'USER.md'), '# User');
      await writeFile(join(tempDir, 'AGENTS.md'), '# Agents');

      const files = await loader.load();
      assert.equal(files.length, 4);
      const names = files.map((f) => f.name);
      assert.ok(names.includes('SOUL.md'));
      assert.ok(names.includes('IDENTITY.md'));
      assert.ok(names.includes('USER.md'));
      assert.ok(names.includes('AGENTS.md'));
    });

    it('skips missing files gracefully', async () => {
      await writeFile(join(tempDir, 'SOUL.md'), '# Soul');
      // Intentionally skip IDENTITY, USER, AGENTS

      const files = await loader.load();
      assert.equal(files.length, 1);
      assert.equal(files[0].name, 'SOUL.md');
    });

    it('returns empty array when no files exist', async () => {
      const files = await loader.load();
      assert.equal(files.length, 0);
    });

    it('returns extended files when extended = true', async () => {
      await writeFile(join(tempDir, 'SOUL.md'), '# Soul');
      await writeFile(join(tempDir, 'IDENTITY.md'), '# Identity');
      await writeFile(join(tempDir, 'USER.md'), '# User');
      await writeFile(join(tempDir, 'AGENTS.md'), '# Agents');
      await writeFile(join(tempDir, 'TOOLS.md'), '# Tools');
      await writeFile(join(tempDir, 'MEMORY.md'), '# Memory');

      const files = await loader.load(true);
      const names = files.map((f) => f.name);
      assert.ok(names.includes('TOOLS.md'));
      assert.ok(names.includes('MEMORY.md'));
      assert.ok(files.length >= 6); // 6 core+extended + any recent memory files
    });
  });

  describe('read()', () => {
    it('returns file content', async () => {
      await writeFile(join(tempDir, 'test.md'), 'hello world');
      const content = await loader.read('test.md');
      assert.equal(content, 'hello world');
    });

    it('returns null for missing files', async () => {
      const content = await loader.read('nonexistent.md');
      assert.equal(content, null);
    });

    it('caches results — second read returns cached value', async () => {
      await writeFile(join(tempDir, 'cached.md'), 'version 1');
      const first = await loader.read('cached.md');
      assert.equal(first, 'version 1');

      // Overwrite on disk
      await writeFile(join(tempDir, 'cached.md'), 'version 2');
      const second = await loader.read('cached.md');
      assert.equal(second, 'version 1', 'Should return cached value, not re-read');
    });
  });

  describe('write()', () => {
    it('creates file and updates cache', async () => {
      await loader.write('new-file.md', 'new content');

      // Should be readable from cache
      const cached = await loader.read('new-file.md');
      assert.equal(cached, 'new content');

      // Should also exist on disk
      const onDisk = await readFile(join(tempDir, 'new-file.md'), 'utf-8');
      assert.equal(onDisk, 'new content');
    });

    it('creates directories recursively', async () => {
      await loader.write('deep/nested/file.md', 'deep content');

      const onDisk = await readFile(join(tempDir, 'deep/nested/file.md'), 'utf-8');
      assert.equal(onDisk, 'deep content');
    });
  });

  describe('buildSystemPrompt()', () => {
    it('includes core file contents with headers', async () => {
      await writeFile(join(tempDir, 'SOUL.md'), 'Be helpful');
      await writeFile(join(tempDir, 'IDENTITY.md'), 'I am Rivet');

      const prompt = await loader.buildSystemPrompt();
      assert.ok(prompt.includes('## SOUL.md'));
      assert.ok(prompt.includes('Be helpful'));
      assert.ok(prompt.includes('## IDENTITY.md'));
      assert.ok(prompt.includes('I am Rivet'));
    });

    it('includes Runtime section with agent ID', async () => {
      const prompt = await loader.buildSystemPrompt('opus');
      assert.ok(prompt.includes('## Runtime'));
      assert.ok(prompt.includes('Agent: opus'));
    });

    it('omits Runtime section when no agent ID', async () => {
      const prompt = await loader.buildSystemPrompt();
      assert.ok(!prompt.includes('## Runtime'));
    });
  });

  describe('buildHeartbeatPrompt()', () => {
    it('includes HEARTBEAT.md when it exists', async () => {
      await writeFile(join(tempDir, 'SOUL.md'), 'soul');
      await writeFile(join(tempDir, 'HEARTBEAT.md'), 'Check email and calendar');

      const prompt = await loader.buildHeartbeatPrompt('opus');
      assert.ok(prompt.includes('## HEARTBEAT.md'));
      assert.ok(prompt.includes('Check email and calendar'));
    });

    it('returns base prompt when HEARTBEAT.md is missing', async () => {
      await writeFile(join(tempDir, 'SOUL.md'), 'soul');

      const base = await loader.buildSystemPrompt('opus');
      const heartbeat = await loader.buildHeartbeatPrompt('opus');
      // Clear cache between calls to avoid stale state
      assert.ok(!heartbeat.includes('HEARTBEAT.md'));
    });
  });

  describe('clearCache()', () => {
    it('forces re-read from disk', async () => {
      await writeFile(join(tempDir, 'cached.md'), 'version 1');
      await loader.read('cached.md');

      // Update on disk
      await writeFile(join(tempDir, 'cached.md'), 'version 2');

      // Before clear — still cached
      const before = await loader.read('cached.md');
      assert.equal(before, 'version 1');

      // After clear — re-reads
      loader.clearCache();
      const after = await loader.read('cached.md');
      assert.equal(after, 'version 2');
    });
  });
});
