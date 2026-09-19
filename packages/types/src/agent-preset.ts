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
}

/** Map a catalog agent id (or an already-canonical harness id) to a HarnessId. */
export function catalogAgentToHarness(id: string): HarnessId | undefined {
  if ((HARNESS_IDS as readonly string[]).includes(id)) return id as HarnessId
  const mapped = CATALOG_AGENT_TO_HARNESS[id]
  if (mapped) return mapped
  return undefined
}

/**
 * Provider plugin key (`providers.<key>` in config.yaml) → its harness id.
 * Inverse of the CLI's HARNESS_PROVIDER_KEYS. Lets a catalog agent whose id
 * isn't itself a harness (e.g. a config agent `rivet` on `claude-cli`) resolve
 * the harness whose model sheet drives its picker.
 */
export const PROVIDER_TO_HARNESS: Record<string, HarnessId> = {
  'claude-cli': 'claude-code',
  'grok-cli': 'grok-build',
  'kimi-code': 'kimi-code',
  'hermes-cli': 'hermes',
  'codex-cli': 'codex',
  'opencode-cli': 'opencode',
  'qwen-code': 'qwen-code',
}

/** Resolve a provider plugin key to its harness id, or undefined if unknown. */
export function providerToHarness(provider: string | undefined): HarnessId | undefined {
  if (!provider) return undefined
  return PROVIDER_TO_HARNESS[provider]
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
