/**
 * SkillManager tests — discover, load, match, list, skill_list tool.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillManagerImpl, createSkillListTool } from './skills.js';

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
