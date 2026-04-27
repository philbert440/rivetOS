/**
 * Skill data-plane tools — `skill_list`, `skill_manage`.
 *
 * Wraps the in-process tools exported by `@rivetos/core` so external MCP
 * clients can list and manage skills the same way local agents can. Both
 * workspace AND system skill dirs are writable from this surface — Phil's
 * call: claude-cli through MCP gets the same skill-write surface in-process
 * Opus has, no second-class citizen.
 *
 * On any successful `skill_manage` write (create/edit/patch/delete/retire/
 * write_file) we rediscover the affected skill dir so a follow-up
 * `skill_list` reflects the change without restart.
 */

import { SkillManagerImpl, createSkillListTool, createSkillManageTool } from '@rivetos/core'
import type { Tool } from '@rivetos/types'
import { z } from 'zod'

import type { ToolRegistration } from '../server.js'
import { adaptRivetTool } from './adapt.js'

export interface SkillToolsOptions {
  /**
   * Directories to scan for skills. Order matters — the first dir is the
   * default write target for `skill_manage create`. Pass workspace dirs
   * first if they should win over system dirs.
   *
   * Falls back to `RIVETOS_SKILL_DIRS` (colon-separated) then to
   * `${HOME}/.rivetos/skills` if nothing is configured.
   */
  skillDirs?: string[]
  /** Optional embedding endpoint for dedup checks during `create`. */
  embedEndpoint?: string
  /** Override the wire-name prefix. Default `` (no prefix). claude-cli prefixes MCP tools as `mcp__<server>__<name>` so we keep the wire name clean. */
  prefix?: string
}

export interface SkillToolsHandle {
  /** All MCP tool registrations — pass into `createMcpServer({ tools: [...] })`. */
  tools: ToolRegistration[]
  /** Skill manager (exposed for tests / future runtime-RPC). */
  manager: SkillManagerImpl
  /** No-op for skill tools — included for symmetry with memory tools. */
  close: () => Promise<void>
}

/**
 * Build the skill tool surface — `skill_list`, `skill_manage`. Discovers
 * skills from the configured dirs at construction time. After any write,
 * the tool wrapper rediscovers the affected dir so subsequent reads see
 * fresh state.
 */
export async function createSkillTools(options: SkillToolsOptions = {}): Promise<SkillToolsHandle> {
  const prefix = options.prefix ?? ''
  const skillDirs = resolveSkillDirs(options.skillDirs)

  const manager = new SkillManagerImpl()
  await manager.discover(skillDirs)

  const listTool = createSkillListTool(manager)

  const manageTool = createSkillManageTool(manager, {
    skillDirs,
    embedEndpoint: options.embedEndpoint,
  })

  // Wrap manage tool to trigger rediscovery on writes — without this,
  // a `create` followed by `list` would miss the new skill.
  const manageWithRediscovery = wrapWithRediscovery(manageTool, manager, skillDirs)

  const tools: ToolRegistration[] = [
    adaptRivetTool(listTool, skillListInputSchema, {
      name: `${prefix}skill_list`,
      description:
        'List all available RivetOS skills with their names and descriptions. ' +
        'Skills are reusable knowledge/workflow definitions discovered from the ' +
        'configured skill directories. Mirrors the in-process `skill_list` tool ' +
        'exposed to local agents.',
    }),
    adaptRivetTool(manageWithRediscovery, skillManageInputSchema, {
      name: `${prefix}skill_manage`,
      description:
        'Create, edit, patch, delete, retire, read, or extend RivetOS skills. ' +
        'Use to save reusable knowledge, workflows, or procedures. Workspace and ' +
        'system skill dirs are both writable. Mirrors the in-process ' +
        '`skill_manage` tool exposed to local agents.',
    }),
  ]

  return {
    tools,
    manager,
    async close() {
      /* nothing to drain */
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSkillDirs(explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) return explicit
  const envValue = process.env.RIVETOS_SKILL_DIRS
  if (envValue) {
    const parts = envValue
      .split(':')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (parts.length > 0) return parts
  }
  const home = process.env.HOME ?? '~'
  return [`${home}/.rivetos/skills`]
}

/**
 * Wrap `skill_manage` so successful writes trigger rediscovery. We can't
 * tell from the string return value alone whether a write happened, so
 * we rediscover after any non-`read` action — cheap (just readdir + stat
 * per dir).
 */
function wrapWithRediscovery(tool: Tool, manager: SkillManagerImpl, skillDirs: string[]): Tool {
  return {
    ...tool,
    execute: async (args, signal, context) => {
      const result = await tool.execute(args, signal, context)
      const action = typeof args.action === 'string' ? args.action : ''
      if (action !== '' && action !== 'read') {
        // Rediscover all dirs — manage may have written to any of them
        // (e.g., retire moves between dirs).
        for (const dir of skillDirs) {
          try {
            await manager.rediscover(dir)
          } catch {
            /* swallow — best-effort */
          }
        }
      }
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// Input schemas — hand-mapped from packages/core/src/domain/skills/*.ts
// ---------------------------------------------------------------------------

export const skillListInputSchema = {} satisfies z.ZodRawShape

export const skillManageInputSchema = {
  action: z
    .enum(['create', 'edit', 'patch', 'delete', 'retire', 'read', 'write_file'])
    .describe('Action to perform'),
  name: z.string().describe('Skill name (lowercase, hyphens, letters, digits only, max 64 chars)'),
  description: z.string().optional().describe('Skill description (required for create)'),
  content: z
    .string()
    .optional()
    .describe('Full SKILL.md content for create/edit, or FIND/REPLACE blocks for patch'),
  file_path: z
    .string()
    .optional()
    .describe('Relative path for write_file (e.g., references/api.md)'),
  file_content: z.string().optional().describe('Content for write_file'),
  category: z.string().optional().describe('Optional category for organizing skills'),
  tags: z.string().optional().describe('Comma-separated tags'),
  level: z
    .number()
    .int()
    .optional()
    .describe('Read detail level: 1 = full SKILL.md + file list (default), 2 = + file contents'),
  force: z
    .boolean()
    .optional()
    .describe('Force creation even if a similar skill exists (bypasses dedup check)'),
  reason: z
    .string()
    .optional()
    .describe('Reason for the change (added to changelog in SKILL.md on edit/patch)'),
} satisfies z.ZodRawShape
