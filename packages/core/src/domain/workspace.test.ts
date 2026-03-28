/**
 * WorkspaceLoader tests — load, read, write, cache, system prompt, heartbeat prompt.
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
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
      await writeFile(join(tempDir, 'CORE.md'), '# Core');
      await writeFile(join(tempDir, 'USER.md'), '# User');
      await writeFile(join(tempDir, 'WORKSPACE.md'), '# Workspace');
      await writeFile(join(tempDir, 'MEMORY.md'), '# Memory');

      const files = await loader.load();
      assert.equal(files.length, 4);
      const names = files.map((f) => f.name);
      assert.ok(names.includes('CORE.md'));
      assert.ok(names.includes('USER.md'));
      assert.ok(names.includes('WORKSPACE.md'));
      assert.ok(names.includes('MEMORY.md'));
    });

    it('skips missing files gracefully', async () => {
      await writeFile(join(tempDir, 'CORE.md'), '# Core');
      // Intentionally skip USER, WORKSPACE, MEMORY

      const files = await loader.load();
      assert.equal(files.length, 1);
      assert.equal(files[0].name, 'CORE.md');
    });

    it('returns empty array when no files exist', async () => {
      const files = await loader.load();
      assert.equal(files.length, 0);
    });

    it('returns extended files when extended = true', async () => {
      await writeFile(join(tempDir, 'CORE.md'), '# Core');
      await writeFile(join(tempDir, 'USER.md'), '# User');
      await writeFile(join(tempDir, 'WORKSPACE.md'), '# Workspace');
      await writeFile(join(tempDir, 'MEMORY.md'), '# Memory');
      await writeFile(join(tempDir, 'CAPABILITIES.md'), '# Capabilities');

      const files = await loader.load(true);
      const names = files.map((f) => f.name);
      assert.ok(names.includes('CAPABILITIES.md'));
      assert.ok(files.length >= 5); // 5 core+extended + any recent memory files
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
      await writeFile(join(tempDir, 'CORE.md'), 'Be helpful');
      await writeFile(join(tempDir, 'USER.md'), 'Phil is the user');

      const prompt = await loader.buildSystemPrompt();
      assert.ok(prompt.includes('## CORE.md'));
      assert.ok(prompt.includes('Be helpful'));
      assert.ok(prompt.includes('## USER.md'));
      assert.ok(prompt.includes('Phil is the user'));
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
      await writeFile(join(tempDir, 'CORE.md'), 'core');
      await writeFile(join(tempDir, 'HEARTBEAT.md'), 'Check email and calendar');

      const prompt = await loader.buildHeartbeatPrompt('opus');
      assert.ok(prompt.includes('## HEARTBEAT.md'));
      assert.ok(prompt.includes('Check email and calendar'));
    });

    it('returns base prompt when HEARTBEAT.md is missing', async () => {
      await writeFile(join(tempDir, 'CORE.md'), 'core');

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

    it('also clears pinned files', async () => {
      await writeFile(join(tempDir, 'pin.ts'), 'pinned content');
      await loader.pinFile('pin.ts');
      assert.equal(loader.getPinnedFiles().length, 1);

      loader.clearCache();
      assert.equal(loader.getPinnedFiles().length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Pinned files — /context add/remove/list/clear
  // -------------------------------------------------------------------------

  describe('pinFile()', () => {
    it('pins a file and includes it in getPinnedFiles', async () => {
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(join(tempDir, 'src/app.ts'), 'const x = 1;');

      const result = await loader.pinFile('src/app.ts');
      assert.ok(!('error' in result));
      if (!('error' in result)) {
        assert.equal(result.name, 'src/app.ts');
        assert.ok(result.size > 0);
      }

      const pinned = loader.getPinnedFiles();
      assert.equal(pinned.length, 1);
      assert.equal(pinned[0].name, 'src/app.ts');
    });

    it('returns error for missing file', async () => {
      const result = await loader.pinFile('nonexistent.ts');
      assert.ok('error' in result);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error for file over 50KB', async () => {
      const bigContent = 'x'.repeat(51 * 1024);
      await writeFile(join(tempDir, 'big.txt'), bigContent);

      const result = await loader.pinFile('big.txt');
      assert.ok('error' in result);
      assert.ok(result.error.includes('too large'));
    });

    it('returns error when total pinned would exceed 200KB', async () => {
      for (let i = 0; i < 4; i++) {
        await writeFile(join(tempDir, `file${i}.txt`), 'x'.repeat(45 * 1024));
        const r = await loader.pinFile(`file${i}.txt`);
        assert.ok(!('error' in r));
      }

      await writeFile(join(tempDir, 'file4.txt'), 'x'.repeat(45 * 1024));
      const result = await loader.pinFile('file4.txt');
      assert.ok('error' in result);
      assert.ok(result.error.includes('200KB'));
    });

    it('allows re-pinning the same file (updates content)', async () => {
      await writeFile(join(tempDir, 'update.ts'), 'version 1');
      await loader.pinFile('update.ts');

      await writeFile(join(tempDir, 'update.ts'), 'version 2 with more bytes');
      const result = await loader.pinFile('update.ts');
      assert.ok(!('error' in result));
      assert.equal(loader.getPinnedFiles().length, 1);
    });
  });

  describe('unpinFile()', () => {
    it('removes a pinned file and returns true', async () => {
      await writeFile(join(tempDir, 'pinme.ts'), 'code');
      await loader.pinFile('pinme.ts');
      assert.equal(loader.getPinnedFiles().length, 1);

      const removed = loader.unpinFile('pinme.ts');
      assert.equal(removed, true);
      assert.equal(loader.getPinnedFiles().length, 0);
    });

    it('returns false for non-pinned file', () => {
      const removed = loader.unpinFile('not-pinned.ts');
      assert.equal(removed, false);
    });
  });

  describe('clearPinnedFiles()', () => {
    it('clears all pinned files and returns count', async () => {
      await writeFile(join(tempDir, 'a.ts'), 'aaa');
      await writeFile(join(tempDir, 'b.ts'), 'bbb');
      await loader.pinFile('a.ts');
      await loader.pinFile('b.ts');
      assert.equal(loader.getPinnedFiles().length, 2);

      const count = loader.clearPinnedFiles();
      assert.equal(count, 2);
      assert.equal(loader.getPinnedFiles().length, 0);
    });

    it('returns 0 when nothing is pinned', () => {
      const count = loader.clearPinnedFiles();
      assert.equal(count, 0);
    });
  });

  describe('pinned files in system prompt', () => {
    it('includes pinned files after workspace files', async () => {
      await writeFile(join(tempDir, 'CORE.md'), '# Core');
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(join(tempDir, 'src/index.ts'), 'export default {}');
      await loader.pinFile('src/index.ts');

      const prompt = await loader.buildSystemPrompt('opus');
      assert.ok(prompt.includes('## Pinned: src/index.ts'));
      assert.ok(prompt.includes('export default {}'));

      // Order: workspace files → pinned → runtime
      const coreIdx = prompt.indexOf('## CORE.md');
      const pinnedIdx = prompt.indexOf('## Pinned:');
      const runtimeIdx = prompt.indexOf('## Runtime');
      assert.ok(pinnedIdx > coreIdx, 'Pinned should come after workspace files');
      assert.ok(runtimeIdx > pinnedIdx, 'Runtime should come after pinned files');
    });

    it('does not include pinned section when nothing is pinned', async () => {
      await writeFile(join(tempDir, 'CORE.md'), '# Core');
      const prompt = await loader.buildSystemPrompt('opus');
      assert.ok(!prompt.includes('## Pinned:'));
    });
  });
});
