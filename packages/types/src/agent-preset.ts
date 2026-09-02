/**
 * Agent-preset migration: old rows stored a catalog agent id in `model`
 * (the mislabelled harness picker). New rows store `harnessId` + a real
 * model id (`''` = harness default).
 */

import { HARNESS_IDS, type HarnessId } from './harness.js'

/** Catalog agent id → harness id. `grok*` is handled separately. */
export const CATALOG_AGENT_TO_HARNESS: Record<string, HarnessId> = {
  claude: 'claude-code',
  grok: 'grok-build',
  'grok-fast': 'grok-build',
  kimi: 'kimi-code',
  hermes: 'hermes',
  deepseek: 'deepseek-harness',
  dsh: 'deepseek-harness',
}

/** Map a catalog agent id (or an already-canonical harness id) to a HarnessId. */
export function catalogAgentToHarness(id: string): HarnessId | undefined {
  if ((HARNESS_IDS as readonly string[]).includes(id)) return id as HarnessId
  const mapped = CATALOG_AGENT_TO_HARNESS[id]
  if (mapped) return mapped
  return undefined
}

/**
 * If `model` is a catalog agent id (or harness id) and `harnessId` is unset,
 * move it to `harnessId` and clear `model` to the harness default.
 */
export function migrateAgentPreset<T extends { model: string; harnessId?: HarnessId }>(
  preset: T,
): T {
  if (preset.harnessId) return preset
  const hid = catalogAgentToHarness(preset.model)
  if (!hid) return preset
  return { ...preset, harnessId: hid, model: '' }
}
