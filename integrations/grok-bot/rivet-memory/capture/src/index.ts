export { capForStorage, eventIdFromContent, createCaptureWriter } from '@rivetos/capture-core'
export type { CaptureMessage, CaptureBatch } from '@rivetos/capture-core'
export { normalizeRecords, toIngestRows } from './normalize.js'
export { parseInput, parsePageHeader, detectFormat, toolResultBody } from './parse.js'
export { stripWrappers, extractUserText, countNoise, addNoise } from './wrappers.js'
export { parseGrokTimestamp, extractTimestampTag, addMs } from './timestamps.js'
export { classifyHidden, extractAgentMessage, systemMarker } from './hidden.js'
export {
  discoverModels,
  resolveIdentity,
  identityFor,
  makeIdentityLookup,
  loadIdentityConfig,
  HISTORICAL_OVERRIDES,
  slug,
  agentIdFromTranscriptPath,
  listInputFiles,
  applySessionSuffix,
} from './identity.js'
export { mergeParsedInputs, normalizePages } from './pages.js'
export {
  assertReadOnlySql,
  loadRivetosPgUrlFromEnv,
  wrapReadOnlyClient,
  withReadOnlyTransaction,
  fetchGrokbotRows,
  LIST_CONVERSATIONS_SQL,
  ROWS_BY_CONVERSATION_SQL,
} from './pg-readonly.js'
export { compareInput, formatCompareTable, formatNoiseBreakdown } from './compare.js'
export {
  recleanFromSource,
  recleanStoredRows,
  recleanContentOnly,
  printRecleanStats,
  v3Session,
  EXISTING_ROWS_SQL,
  FROM_ROWS_LIMITS,
} from './reclean.js'
export {
  legacyNormalizeRecords,
  legacyFlatten,
  shrinkToolResults,
  LEGACY_TOOL_RESULT_MAX,
} from './legacy.js'
export { main as runCli } from './cli.js'
export {
  CAPTURE_CHANNEL,
  CAPTURE_SOURCE,
  SESSION_SUFFIX_V3,
  STORAGE_LIMIT,
  SUBAGENT_AGENT,
  ORDINAL_STRIDE,
} from './types.js'
export type {
  BotIdentity,
  HiddenKind,
  IngestRow,
  InputFormat,
  NormalizeOptions,
  NormalizeResult,
  NormalizeStats,
  NoiseCounts,
  PageHeader,
  ParsedInput,
  StoredRow,
} from './types.js'
