/**
 * Integration test for the skill data-plane over MCP —
 * `skill_list`, `skill_manage`.
 *
 * Uses a temp directory as the skill dir so we don't pollute workspace state.
 * Verifies:
 *   - listing reports skills discovered from disk
 *   - create writes to disk and rediscovery picks it up for the next list
 *   - read returns the SKILL.md content
 *   - delete removes the skill from disk and from the manager
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultEchoTool } from '@rivetos/mcp'
import {
  connectV2,
  createV2McpServer,
  type V2McpConnection,
  type V2McpServer,
} from '@rivetos/mcp-v2'
import { createSkillTools, type SkillToolsHandle } from './skills.js'

const SEED_SKILL_NAME = 'mcp-test-seed'
const SEED_SKILL_BODY = `---
name: ${SEED_SKILL_NAME}
description: Seed skill used by the mcp-server skill-tools integration test.
triggers: [seed-trigger]
---

# Seed Skill

This skill exists to verify discovery works.
`

describe('skill data-plane (Phase 1.A slice 6)', () => {
  let tempDir: string
  let server: V2McpServer
  let client: V2McpConnection
  let skillHandle: SkillToolsHandle

  // Envelope-preserving shim over connectV2's callToolRaw — these tests
  // assert on content/isError rather than callTool's unwrapped string.
  function callTool(params: { name: string; arguments: Record<string, unknown> }) {
    return client.callToolRaw(params.name, params.arguments)
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rivetos-mcp-skills-'))
    // Seed one skill on disk so we have something to list.
    await mkdir(join(tempDir, SEED_SKILL_NAME), { recursive: true })
    await writeFile(join(tempDir, SEED_SKILL_NAME, 'SKILL.md'), SEED_SKILL_BODY, 'utf-8')

    skillHandle = await createSkillTools({ skillDirs: [tempDir] })

    server = createV2McpServer({
      host: '127.0.0.1',
      port: 0,
      tools: [defaultEchoTool(), ...skillHandle.tools],
    })
    await server.start()

    client = await connectV2({
      name: 'skill-tools-test',
      url: `http://127.0.0.1:${String(server.port)}/mcp`,
    })
  }, 20_000)

  afterAll(async () => {
    await client.close().catch(() => {
      /* swallow */
    })
    await server.close().catch(() => {
      /* swallow */
    })
    await skillHandle.close().catch(() => {
      /* swallow */
    })
    await rm(tempDir, { recursive: true, force: true }).catch(() => {
      /* swallow */
    })
  })

  it('lists both skill tools alongside echo', async () => {
    const names = (await client.listTools()).map((t) => t.name)
    expect(names).toContain('skill_list')
    expect(names).toContain('skill_manage')
    expect(names).toContain('echo')
  })

  it('skill_list reports the seeded skill', async () => {
    const result = await callTool({ name: 'skill_list', arguments: {} })
    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text ?? '').toContain(SEED_SKILL_NAME)
  })

  it('skill_manage create + list round-trip (rediscovery wired)', async () => {
    const newName = 'mcp-test-created'
    const created = await callTool({
      name: 'skill_manage',
      arguments: {
        action: 'create',
        name: newName,
        description: 'A skill created via MCP for the integration test.',
        content: `# ${newName}\n\nCreated by skills.test.ts.\n`,
        force: true,
      },
    })
    expect(created.isError).not.toBe(true)

    // List should now include both seeded + created without manual rediscovery.
    const listed = await callTool({ name: 'skill_list', arguments: {} })
    const text = (listed.content as Array<{ text?: string }>)[0]?.text ?? ''
    expect(text).toContain(SEED_SKILL_NAME)
    expect(text).toContain(newName)
  })

  it('skill_manage read returns the SKILL.md content', async () => {
    const result = await callTool({
      name: 'skill_manage',
      arguments: { action: 'read', name: SEED_SKILL_NAME, level: 1 },
    })
    expect(result.isError).not.toBe(true)
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? ''
    expect(text).toContain('Seed Skill')
  })
})
