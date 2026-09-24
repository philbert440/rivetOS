export type {
  AgentRegistryBackend,
  AgentPresetInput,
  AgentPresetPatch,
  AgentPresetStore,
} from './store.js'
export {
  PresetConflictError,
  nameKey,
  sortPresets,
  findPresetByHandle,
  presetFromCreate,
  presetFromPatch,
} from './store.js'

export { FileAgentPresetStore, type FileAgentPresetStoreOptions } from './file-store.js'
export { PgAgentPresetStore, type PgAgentPresetStoreOptions } from './pg-store.js'
export {
  createFallbackPresetStore,
  type FallbackAgentPresetStore,
  type FallbackPresetStoreOptions,
} from './fallback-store.js'

export {
  COLOR_RE,
  EFFORT_RE,
  isHarnessId,
  parseEffort,
  parseHarnessId,
  parseColor,
  isRecord,
  isAgentPreset,
  slugify,
  defaultDirectoryFor,
  validateDirectory,
  canonicalPath,
  directoryWarnings,
} from './validate.js'

export {
  ensureAgentDirectory,
  type EnsureAgentDirectoryOptions,
  type EnsureAgentDirectoryResult,
} from './directory.js'

export {
  createCachedPresetResolver,
  type CachedPresetResolver,
  type CachedPresetResolverOptions,
  type CachedPresetResolverStatus,
} from './cached-resolver.js'

export {
  importLegacyAgentsJson,
  type ImportLegacyAgentsArgs,
  type ImportLegacyAgentsResult,
} from './import-legacy.js'
