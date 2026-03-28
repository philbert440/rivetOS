/**
 * SkillManager tests — discover, load, match, list, skill_list tool, skill_manage tool.
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillManagerImpl, createSkillListTool, createSkillManageTool, scanSkillContent, cosineSimilarity } from './skills/index.js';

describe('SkillManagerImpl', () => {
  let tempDir: string;
  let manager: SkillManagerImpl;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rivetos-skills-test-'));
    manager = new SkillManagerImpl();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Helper — create a skill directory with SKILL.md
  async function createSkill(name: string, content: string): Promise<void> {
    const dir = join(tempDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), content);
  }

  describe('discover()', () => {
    it('finds skills in directories with SKILL.md', async () => {
      await createSkill('camera', '---\nname: Camera\ndescription: Controls cameras\ntriggers: camera, surveillance, ptz\n---\n# Camera Skill');
      await createSkill('email', '---\nname: Email\ndescription: Send and read emails\ntriggers: email, gmail, inbox\n---\n# Email Skill');

      const skills = await manager.discover([tempDir]);
      assert.equal(skills.length, 2);
      const names = skills.map((s) => s.name);
      assert.ok(names.includes('Camera'));
      assert.ok(names.includes('Email'));
    });

    it('skips directories without SKILL.md', async () => {
      await mkdir(join(tempDir, 'no-skill'), { recursive: true });
      await writeFile(join(tempDir, 'no-skill', 'README.md'), '# Not a skill');

      const skills = await manager.discover([tempDir]);
      assert.equal(skills.length, 0);
    });

    it('parses YAML frontmatter for name, description, triggers', async () => {
      await createSkill('weather', '---\nname: Weather\ndescription: Check weather forecasts\ntriggers: weather, forecast, temperature\n---');

      await manager.discover([tempDir]);
      const skills = manager.list();
      assert.equal(skills.length, 1);

      const skill = skills[0];
      assert.equal(skill.name, 'Weather');
      assert.equal(skill.description, 'Check weather forecasts');
      assert.ok(skill.triggers!.includes('weather'));
      assert.ok(skill.triggers!.includes('forecast'));
      assert.ok(skill.triggers!.includes('temperature'));
    });

    it('falls back to markdown heading and first paragraph when no frontmatter', async () => {
      await createSkill('fallback', '# My Cool Skill\nThis skill does amazing things.\n\n## Usage\nRun it.');

      await manager.discover([tempDir]);
      const skills = manager.list();
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'My Cool Skill');
      assert.equal(skills[0].description, 'This skill does amazing things.');
    });

    it('handles non-existent directories gracefully', async () => {
      const skills = await manager.discover(['/tmp/this-does-not-exist-at-all']);
      assert.equal(skills.length, 0);
    });

    it('scans multiple skill directories', async () => {
      const secondDir = await mkdtemp(join(tmpdir(), 'rivetos-skills-test-2-'));
      try {
        await createSkill('skill-a', '---\nname: Skill A\ndescription: First\n---');
        const dir2skill = join(secondDir, 'skill-b');
        await mkdir(dir2skill, { recursive: true });
        await writeFile(join(dir2skill, 'SKILL.md'), '---\nname: Skill B\ndescription: Second\n---');

        const skills = await manager.discover([tempDir, secondDir]);
        assert.equal(skills.length, 2);
      } finally {
        await rm(secondDir, { recursive: true, force: true });
      }
    });

    it('uses directory name when frontmatter has no name', async () => {
      await createSkill('my-dir-name', '---\ndescription: No name field\n---');

      await manager.discover([tempDir]);
      const skills = manager.list();
      assert.equal(skills[0].name, 'my-dir-name');
    });
  });

  describe('load()', () => {
    it('returns full SKILL.md content', async () => {
      const content = '---\nname: Full\ndescription: Full content test\n---\n# Full Skill\n\nDetailed instructions here.';
      await createSkill('full', content);

      await manager.discover([tempDir]);
      const loaded = await manager.load('Full');
      assert.equal(loaded, content);
    });

    it('throws for unknown skill name', async () => {
      await assert.rejects(
        () => manager.load('nonexistent'),
        (err: Error) => {
          assert.ok(err.message.includes('Skill not found'));
          return true;
        },
      );
    });
  });

  describe('match()', () => {
    it('returns skill matching query keywords', async () => {
      await createSkill('camera', '---\nname: Camera\ndescription: Control PTZ cameras\ntriggers: camera, ptz, surveillance\n---');
      await createSkill('email', '---\nname: Email\ndescription: Send and read email\ntriggers: email, gmail, inbox\n---');

      await manager.discover([tempDir]);
      const result = manager.match('show me the camera feed');
      assert.ok(result);
      assert.equal(result.name, 'Camera');
    });

    it('returns null for unrelated queries', async () => {
      await createSkill('camera', '---\nname: Camera\ndescription: Control cameras\ntriggers: camera, ptz\n---');

      await manager.discover([tempDir]);
      const result = manager.match('what is the meaning of life');
      assert.equal(result, null);
    });

    it('returns null when no skills are loaded', () => {
      const result = manager.match('anything');
      assert.equal(result, null);
    });

    it('prefers exact name matches', async () => {
      await createSkill('search', '---\nname: Search\ndescription: Web search\ntriggers: search, web, google\n---');
      await createSkill('grep', '---\nname: Grep\ndescription: Search files with grep\ntriggers: grep, find, search\n---');

      await manager.discover([tempDir]);
      const result = manager.match('use grep to find the file');
      assert.ok(result);
      assert.equal(result.name, 'Grep');
    });
  });

  describe('list()', () => {
    it('returns all discovered skills', async () => {
      await createSkill('one', '---\nname: One\ndescription: First\n---');
      await createSkill('two', '---\nname: Two\ndescription: Second\n---');
      await createSkill('three', '---\nname: Three\ndescription: Third\n---');

      await manager.discover([tempDir]);
      assert.equal(manager.list().length, 3);
    });

    it('returns empty array before discover', () => {
      assert.deepEqual(manager.list(), []);
    });
  });

  describe('rediscover()', () => {
    it('refreshes skills from a specific directory', async () => {
      await createSkill('alpha', '---\nname: alpha\ndescription: Alpha skill\n---');
      await manager.discover([tempDir]);
      assert.equal(manager.list().length, 1);

      // Add a new skill to the same dir
      await createSkill('beta', '---\nname: beta\ndescription: Beta skill\n---');
      await manager.rediscover(tempDir);
      assert.equal(manager.list().length, 2);
    });

    it('removes deleted skills on rediscover', async () => {
      await createSkill('to-delete', '---\nname: to-delete\ndescription: Will be deleted\n---');
      await manager.discover([tempDir]);
      assert.equal(manager.list().length, 1);

      // Remove the skill dir
      await rm(join(tempDir, 'to-delete'), { recursive: true, force: true });
      await manager.rediscover(tempDir);
      assert.equal(manager.list().length, 0);
    });
  });

  describe('getSkillDirs()', () => {
    it('returns dirs after discover', async () => {
      await manager.discover([tempDir, '/tmp/other']);
      const dirs = manager.getSkillDirs();
      assert.deepEqual(dirs, [tempDir, '/tmp/other']);
    });
  });
});

describe('createSkillListTool', () => {
  it('returns properly structured tool', () => {
    const manager = new SkillManagerImpl();
    const tool = createSkillListTool(manager);
    assert.equal(tool.name, 'skill_list');
    assert.ok(tool.description);
    assert.ok(tool.parameters);
    assert.ok(typeof tool.execute === 'function');
  });

  it('returns formatted skill list', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'rivetos-skills-tool-'));
    try {
      const manager = new SkillManagerImpl();
      const skillDir = join(tempDir, 'test-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '---\nname: TestSkill\ndescription: A test skill\n---');

      await manager.discover([tempDir]);
      const tool = createSkillListTool(manager);
      const result = await tool.execute({});
      assert.ok(typeof result === 'string');
      assert.ok(result.includes('TestSkill'));
      assert.ok(result.includes('A test skill'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns "No skills" message when empty', async () => {
    const manager = new SkillManagerImpl();
    const tool = createSkillListTool(manager);
    const result = await tool.execute({});
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('No skills'));
  });
});

// ---------------------------------------------------------------------------
// scanSkillContent
// ---------------------------------------------------------------------------

describe('scanSkillContent', () => {
  it('allows clean markdown content', () => {
    const result = scanSkillContent('# My Skill\n\nThis skill helps with weather.\n\n## Usage\n\n```bash\ncurl "wttr.in/London"\n```');
    assert.equal(result.safe, true);
    assert.equal(result.issues.length, 0);
  });

  it('blocks shell injection via $()', () => {
    const result = scanSkillContent('Run this: $(whoami)');
    assert.equal(result.safe, false);
    assert.ok(result.issues.some((i) => i.includes('Shell injection')));
  });

  it('blocks eval() calls', () => {
    const result = scanSkillContent('eval(userInput)');
    assert.equal(result.safe, false);
    assert.ok(result.issues.some((i) => i.includes('eval')));
  });

  it('blocks hardcoded passwords', () => {
    const result = scanSkillContent('password= "secret123"');
    assert.equal(result.safe, false);
    assert.ok(result.issues.some((i) => i.toLowerCase().includes('password')));
  });

  it('blocks hardcoded API keys', () => {
    const result = scanSkillContent('api_key= "sk-abc123"');
    assert.equal(result.safe, false);
    assert.ok(result.issues.some((i) => i.toLowerCase().includes('api key')));
  });

  it('blocks dangerous rm -rf /', () => {
    const result = scanSkillContent('rm -rf /');
    assert.equal(result.safe, false);
    assert.ok(result.issues.some((i) => i.includes('rm -rf')));
  });

  it('blocks chmod 777', () => {
    const result = scanSkillContent('chmod 777 /var/www');
    assert.equal(result.safe, false);
    assert.ok(result.issues.some((i) => i.includes('chmod 777')));
  });
});

// ---------------------------------------------------------------------------
// skill_manage tool
// ---------------------------------------------------------------------------

describe('skill_manage tool', () => {
  let tempDir: string;
  let manager: SkillManagerImpl;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rivetos-skill-manage-'));
    manager = new SkillManagerImpl();
    await manager.discover([tempDir]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a skill with auto-generated SKILL.md', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    const result = await tool.execute({ action: 'create', name: 'my-skill', description: 'A test skill' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('created'));

    // Verify the file exists
    const content = await readFile(join(tempDir, 'my-skill', 'SKILL.md'), 'utf-8');
    assert.ok(content.includes('name: my-skill'));
    assert.ok(content.includes('A test skill'));

    // Verify _meta.json
    const metaRaw = await readFile(join(tempDir, 'my-skill', '_meta.json'), 'utf-8');
    const meta = JSON.parse(metaRaw);
    assert.equal(meta.version, 1);
    assert.equal(meta.created_by, 'agent');
  });

  it('creates a skill with custom content', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    const customContent = '---\nname: custom\ndescription: Custom skill\n---\n# Custom\n\nDo custom things.';
    const result = await tool.execute({ action: 'create', name: 'custom', content: customContent });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('created'));

    const content = await readFile(join(tempDir, 'custom', 'SKILL.md'), 'utf-8');
    assert.equal(content, customContent);
  });

  it('rejects invalid names with spaces', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    const result = await tool.execute({ action: 'create', name: 'my skill', description: 'Bad name' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Invalid skill name'));
  });

  it('rejects invalid names with uppercase', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    const result = await tool.execute({ action: 'create', name: 'MySkill', description: 'Bad name' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Invalid skill name'));
  });

  it('rejects duplicate skill names', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'dup-test', description: 'First' });
    const result = await tool.execute({ action: 'create', name: 'dup-test', description: 'Second' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('already exists'));
  });

  it('edits a skill (full replace)', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'editable', description: 'Original' });

    const newContent = '---\nname: editable\ndescription: Updated\n---\n# Editable\n\nNew content.';
    const result = await tool.execute({ action: 'edit', name: 'editable', content: newContent });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('updated'));
    assert.ok(result.includes('version 2'));

    const content = await readFile(join(tempDir, 'editable', 'SKILL.md'), 'utf-8');
    // M4.4: edit now bumps version in frontmatter and appends changelog
    assert.ok(content.includes('name: editable'));
    assert.ok(content.includes('description: Updated'));
    assert.ok(content.includes('version: 2'));
    assert.ok(content.includes('## Changelog'));
  });

  it('patches a skill with FIND/REPLACE', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    const original = '---\nname: patchable\ndescription: Patchable skill\n---\n# Patchable\n\nOriginal text here.';
    await tool.execute({ action: 'create', name: 'patchable', content: original });

    const patch = 'FIND: Original text here.\nREPLACE: Patched text instead.';
    const result = await tool.execute({ action: 'patch', name: 'patchable', content: patch });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('patched'));
    assert.ok(result.includes('1 replacements'));

    const content = await readFile(join(tempDir, 'patchable', 'SKILL.md'), 'utf-8');
    assert.ok(content.includes('Patched text instead.'));
    assert.ok(!content.includes('Original text here.'));
  });

  it('patch errors when FIND text not found', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'patch-fail', description: 'Test' });

    const patch = 'FIND: this text does not exist\nREPLACE: whatever';
    const result = await tool.execute({ action: 'patch', name: 'patch-fail', content: patch });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('not found'));
  });

  it('deletes a skill to .trash', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'to-delete', description: 'Delete me' });

    const result = await tool.execute({ action: 'delete', name: 'to-delete' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('trash'));

    // Original dir should be gone
    await assert.rejects(() => stat(join(tempDir, 'to-delete')));

    // .trash should exist with the skill
    const trashEntries = await import('node:fs/promises').then((fs) =>
      fs.readdir(join(tempDir, '.trash')),
    );
    assert.ok(trashEntries.some((e) => e.startsWith('to-delete-')));
  });

  it('reads a skill with content and file listing', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'readable', description: 'Read me' });

    // Add a reference file
    await mkdir(join(tempDir, 'readable', 'references'), { recursive: true });
    await writeFile(join(tempDir, 'readable', 'references', 'api.md'), '# API docs');

    const result = await tool.execute({ action: 'read', name: 'readable' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Read me'));
    assert.ok(result.includes('references/api.md'));
  });

  it('writes a supporting file', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'with-files', description: 'Has files' });

    const result = await tool.execute({
      action: 'write_file',
      name: 'with-files',
      file_path: 'references/guide.md',
      file_content: '# Guide\n\nSome guide content.',
    });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('File written'));

    const content = await readFile(join(tempDir, 'with-files', 'references', 'guide.md'), 'utf-8');
    assert.ok(content.includes('Guide'));
  });

  it('rejects write_file to disallowed paths', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'path-test', description: 'Test' });

    const result = await tool.execute({
      action: 'write_file',
      name: 'path-test',
      file_path: '../../etc/passwd',
      file_content: 'bad stuff',
    });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Invalid file path') || result.includes('Path traversal'));
  });

  it('rejects write_file to unapproved subdir', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'subdir-test', description: 'Test' });

    const result = await tool.execute({
      action: 'write_file',
      name: 'subdir-test',
      file_path: 'config/secret.yaml',
      file_content: 'not allowed',
    });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Invalid file path'));
  });

  it('rejects creation with unsafe content', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    const result = await tool.execute({
      action: 'create',
      name: 'evil-skill',
      content: '---\nname: evil-skill\ndescription: Evil\n---\n# Evil\n\nRun $(rm -rf /)',
    });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Security scan failed'));
  });

  it('reads a skill at level 2 with file contents', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'deep-read', description: 'Deep read test' });

    // Add supporting files
    await mkdir(join(tempDir, 'deep-read', 'references'), { recursive: true });
    await writeFile(join(tempDir, 'deep-read', 'references', 'api.md'), '# API Reference\n\nEndpoint: /v1/things');
    await mkdir(join(tempDir, 'deep-read', 'templates'), { recursive: true });
    await writeFile(join(tempDir, 'deep-read', 'templates', 'config.yaml'), 'port: 8080\nhost: localhost');

    const result = await tool.execute({ action: 'read', name: 'deep-read', level: 2 });
    assert.ok(typeof result === 'string');
    // Level 2 should include file contents
    assert.ok(result.includes('File Contents'));
    assert.ok(result.includes('API Reference'));
    assert.ok(result.includes('Endpoint: /v1/things'));
    assert.ok(result.includes('port: 8080'));
  });

  it('level 1 read does not include file contents', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'shallow-read', description: 'Shallow read test' });

    await mkdir(join(tempDir, 'shallow-read', 'references'), { recursive: true });
    await writeFile(join(tempDir, 'shallow-read', 'references', 'secret.md'), 'TOP SECRET DATA');

    const result = await tool.execute({ action: 'read', name: 'shallow-read', level: 1 });
    assert.ok(typeof result === 'string');
    // Should list the file but NOT include its contents
    assert.ok(result.includes('references/secret.md'));
    assert.ok(!result.includes('TOP SECRET DATA'));
    assert.ok(!result.includes('File Contents'));
  });

  it('skill_list shows version and file count', async () => {
    const listTool = createSkillListTool(manager);
    const manageTool = createSkillManageTool(manager, { skillDirs: [tempDir] });

    await manageTool.execute({ action: 'create', name: 'rich-list', description: 'Rich listing test' });
    await mkdir(join(tempDir, 'rich-list', 'references'), { recursive: true });
    await writeFile(join(tempDir, 'rich-list', 'references', 'doc.md'), '# Docs');
    // Rediscover so the list tool picks up the new skill
    await manager.rediscover(tempDir);

    const result = await listTool.execute({});
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('rich-list'));
    assert.ok(result.includes('v1'));
    assert.ok(result.includes('1 file'));
  });
});

// ---------------------------------------------------------------------------
// M4.4 — Skill Self-Improvement: version bump, changelog, retire
// ---------------------------------------------------------------------------

describe('skill_manage M4.4 — version bump & changelog', () => {
  let tempDir: string;
  let manager: SkillManagerImpl;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rivetos-skill-m44-'));
    manager = new SkillManagerImpl();
    await manager.discover([tempDir]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('edit bumps version in frontmatter and appends changelog', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'versioned', description: 'Versioned skill' });

    const newContent = '---\nname: versioned\ndescription: Updated skill\n---\n# Versioned\n\nNew content.';
    const result = await tool.execute({ action: 'edit', name: 'versioned', content: newContent, reason: 'Improved instructions' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('version 2'));

    const content = await readFile(join(tempDir, 'versioned', 'SKILL.md'), 'utf-8');
    assert.ok(content.includes('version: 2'));
    assert.ok(content.includes('## Changelog'));
    assert.ok(content.includes('Improved instructions'));
    assert.ok(content.includes('**v2**'));
  });

  it('patch bumps version in frontmatter and appends changelog', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    const original = '---\nname: patchver\ndescription: Patchable\nversion: 1\n---\n# Patchable\n\nOriginal text.';
    await tool.execute({ action: 'create', name: 'patchver', content: original });

    const patch = 'FIND: Original text.\nREPLACE: Better text.';
    const result = await tool.execute({ action: 'patch', name: 'patchver', content: patch, reason: 'Fixed wording' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('version 2'));

    const content = await readFile(join(tempDir, 'patchver', 'SKILL.md'), 'utf-8');
    assert.ok(content.includes('version: 2'));
    assert.ok(content.includes('## Changelog'));
    assert.ok(content.includes('Fixed wording'));
    assert.ok(content.includes('Better text.'));
    assert.ok(!content.includes('Original text.'));
  });

  it('successive edits accumulate changelog entries', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'multi-edit', description: 'Multi-edit test' });

    // First edit
    const v2Content = '---\nname: multi-edit\ndescription: V2\n---\n# Multi Edit\n\nVersion 2.';
    await tool.execute({ action: 'edit', name: 'multi-edit', content: v2Content, reason: 'First update' });

    // Read back content for second edit (includes changelog from first)
    const afterV2 = await readFile(join(tempDir, 'multi-edit', 'SKILL.md'), 'utf-8');

    // Second edit — pass the content back (with changelog) so it accumulates
    await tool.execute({ action: 'edit', name: 'multi-edit', content: afterV2, reason: 'Second update' });

    const finalContent = await readFile(join(tempDir, 'multi-edit', 'SKILL.md'), 'utf-8');
    assert.ok(finalContent.includes('First update'));
    assert.ok(finalContent.includes('Second update'));
    assert.ok(finalContent.includes('**v3**'));
  });

  it('edit without reason uses default changelog message', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'no-reason', description: 'No reason test' });

    const newContent = '---\nname: no-reason\ndescription: Updated\n---\n# No Reason\n\nNew.';
    await tool.execute({ action: 'edit', name: 'no-reason', content: newContent });

    const content = await readFile(join(tempDir, 'no-reason', 'SKILL.md'), 'utf-8');
    assert.ok(content.includes('Updated'));
  });
});

describe('skill_manage M4.4 — retire', () => {
  let tempDir: string;
  let manager: SkillManagerImpl;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rivetos-skill-retire-'));
    manager = new SkillManagerImpl();
    await manager.discover([tempDir]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('retires a skill to retired/ directory', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'old-skill', description: 'Retiring this' });

    const result = await tool.execute({ action: 'retire', name: 'old-skill', reason: 'Superseded by new-skill' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('retired'));
    assert.ok(result.includes('Superseded by new-skill'));

    // Original dir should be gone
    await assert.rejects(() => stat(join(tempDir, 'old-skill')));

    // Should exist in retired/
    const retiredStat = await stat(join(tempDir, 'retired', 'old-skill'));
    assert.ok(retiredStat.isDirectory());

    // _meta.json should have retirement info
    const metaRaw = await readFile(join(tempDir, 'retired', 'old-skill', '_meta.json'), 'utf-8');
    const meta = JSON.parse(metaRaw);
    assert.ok(meta.retired_at);
    assert.equal(meta.retired_reason, 'Superseded by new-skill');
  });

  it('retire removes skill from active list', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    await tool.execute({ action: 'create', name: 'to-retire', description: 'Will retire' });
    assert.equal(manager.list().length, 1);

    await tool.execute({ action: 'retire', name: 'to-retire' });
    assert.equal(manager.list().length, 0);
  });

  it('retire returns error for non-existent skill', async () => {
    const tool = createSkillManageTool(manager, { skillDirs: [tempDir] });
    const result = await tool.execute({ action: 'retire', name: 'nonexistent' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('not found'));
  });
});

describe('frontmatter parsing — extended fields', () => {
  let tempDir: string;
  let manager: SkillManagerImpl;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rivetos-fm-'));
    manager = new SkillManagerImpl();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses version, category, tags from frontmatter', async () => {
    const skillDir = join(tempDir, 'rich-fm');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: rich-fm\ndescription: Rich metadata\nversion: 3\ncategory: devops\ntags: docker, kubernetes, deploy\n---\n# Rich FM');

    await manager.discover([tempDir]);
    const skills = manager.list();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].version, 3);
    assert.equal(skills[0].category, 'devops');
    assert.deepEqual(skills[0].tags, ['docker', 'kubernetes', 'deploy']);
  });

  it('missing version/category/tags are undefined', async () => {
    const skillDir = join(tempDir, 'minimal');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: minimal\ndescription: Minimal\n---');

    await manager.discover([tempDir]);
    const skills = manager.list();
    assert.equal(skills[0].version, undefined);
    assert.equal(skills[0].category, undefined);
    assert.equal(skills[0].tags, undefined);
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3, 4, 5];
    const sim = cosineSimilarity(v, v);
    assert.ok(Math.abs(sim - 1.0) < 0.0001);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const sim = cosineSimilarity(a, b);
    assert.ok(Math.abs(sim) < 0.0001);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    const sim = cosineSimilarity(a, b);
    assert.ok(Math.abs(sim - (-1.0)) < 0.0001);
  });

  it('returns 0 for empty vectors', () => {
    assert.equal(cosineSimilarity([], []), 0);
  });

  it('returns 0 for mismatched lengths', () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });

  it('handles zero vectors', () => {
    assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  });

  it('computes correct similarity for known vectors', () => {
    // cos(45°) ≈ 0.7071
    const a = [1, 0];
    const b = [1, 1];
    const sim = cosineSimilarity(a, b);
    assert.ok(Math.abs(sim - 0.7071) < 0.001);
  });
});
