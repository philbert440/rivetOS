/**
 * Skill system — barrel re-exports.
 *
 * Maintains the same public API as the original skills.ts:
 * - SkillManagerImpl (class)
 * - createSkillListTool (function)
 * - createSkillManageTool (function)
 * - scanSkillContent (function)
 * - SkillManageToolOptions (type)
 * - cosineSimilarity (function — new in M4.3)
 */

export { SkillManagerImpl } from './manager.js'
export { createSkillListTool } from './list-tool.js'
export { createSkillManageTool } from './manage-tool.js'
export type { SkillManageToolOptions } from './manage-tool.js'
export { cosineSimilarity } from './manage-tool.js'
export { scanSkillContent } from './security.js'
