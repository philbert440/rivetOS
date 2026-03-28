/**
 * skill_manage tool — create, edit, patch, delete, read, and extend skills.
 *
 * M4.3 features:
 * - Embedding-based dedup check before creation (cosine similarity > 0.85 = warning)
 * - Progressive disclosure: Level 1 = full SKILL.md, Level 2 = + supporting file contents
 * - Security scanning on all content writes
 * - Atomic writes (tempfile + rename)
 * - Provenance tracking (_meta.json)
 *
 * Action handlers live in manage-actions.ts, helpers in manage-helpers.ts.
 */

import { join } from 'node:path'
import type { SkillManager, Tool } from '@rivetos/types'
import {
  handleCreate,
  handleEdit,
  handlePatch,
  handleDelete,
  handleRetire,
  handleRead,
  handleWriteFile,
} from './manage-actions.js'

// Re-export cosineSimilarity for the barrel (used by tests)
export { cosineSimilarity } from './manage-helpers.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for the skill_manage tool */
export interface SkillManageToolOptions {
  /** Directories to look for/create skills in */
  skillDirs: string[]
  /** Whether new auto-created skills go to pending dir (default: false) */
  pendingGate?: boolean
  /** Directory for pending skills (default: first skillDir + '/pending') */
  pendingDir?: string
  /** Embedding endpoint for dedup checks (optional — degrades gracefully) */
  embedEndpoint?: string
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the skill_manage tool — allows agents to create, edit, patch,
 * delete, read, and extend skills at runtime.
 */
export function createSkillManageTool(manager: SkillManager, opts: SkillManageToolOptions): Tool {
  const targetDir = opts.pendingGate
    ? (opts.pendingDir ?? join(opts.skillDirs[0], 'pending'))
    : opts.skillDirs[0]

  return {
    name: 'skill_manage',
    description:
      'Create, edit, patch, or delete skills. Use to save reusable knowledge, workflows, or procedures.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'edit', 'patch', 'delete', 'retire', 'read', 'write_file'],
          description: 'Action to perform',
        },
        name: {
          type: 'string',
          description: 'Skill name (lowercase, hyphens, letters, digits only, max 64 chars)',
        },
        description: {
          type: 'string',
          description: 'Skill description (required for create)',
        },
        content: {
          type: 'string',
          description: 'Full SKILL.md content for create/edit, or FIND/REPLACE blocks for patch',
        },
        file_path: {
          type: 'string',
          description: 'Relative path for write_file (e.g., references/api.md)',
        },
        file_content: {
          type: 'string',
          description: 'Content for write_file',
        },
        category: {
          type: 'string',
          description: 'Optional category for organizing skills',
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tags',
        },
        level: {
          type: 'number',
          description:
            'Read detail level: 1 = full SKILL.md + file list (default), 2 = + file contents',
        },
        force: {
          type: 'boolean',
          description: 'Force creation even if a similar skill exists (bypasses dedup check)',
        },
        reason: {
          type: 'string',
          description: 'Reason for the change (added to changelog in SKILL.md on edit/patch)',
        },
      },
      required: ['action', 'name'],
    },

    execute: async (args: Record<string, unknown>): Promise<string> => {
      const action = typeof args.action === 'string' ? args.action : ''
      const name = typeof args.name === 'string' ? args.name : ''
      const description = typeof args.description === 'string' ? args.description : undefined
      const content = typeof args.content === 'string' ? args.content : undefined
      const filePath = typeof args.file_path === 'string' ? args.file_path : undefined
      const fileContent = typeof args.file_content === 'string' ? args.file_content : undefined
      const category = typeof args.category === 'string' ? args.category : undefined
      const tags = typeof args.tags === 'string' ? args.tags : undefined
      const level = typeof args.level === 'number' ? args.level : 1
      const force = Boolean(args.force)
      const reason = typeof args.reason === 'string' ? args.reason : undefined

      switch (action) {
        case 'create':
          return handleCreate(
            manager,
            targetDir,
            name,
            description,
            content,
            category,
            tags,
            force,
            opts.embedEndpoint,
          )
        case 'edit':
          return handleEdit(manager, name, content, reason)
        case 'patch':
          return handlePatch(manager, name, content, reason)
        case 'delete':
          return handleDelete(manager, name)
        case 'retire':
          return handleRetire(manager, name, reason, opts.skillDirs)
        case 'read':
          return handleRead(manager, name, level)
        case 'write_file':
          return handleWriteFile(manager, name, filePath, fileContent)
        default:
          return `Unknown action: "${action}". Use: create, edit, patch, delete, retire, read, write_file`
      }
    },
  }
}
