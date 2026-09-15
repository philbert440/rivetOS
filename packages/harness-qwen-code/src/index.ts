/**
 * @rivetos/harness-qwen-code
 *
 * The qwen-code half of the harness control plane's task side: a
 * `HarnessExecutor` that drives the local `qwen` binary headlessly
 * (`qwen -p --output-format stream-json`) and reconciles the turn's usage
 * out of stdout or qwen's own session jsonl after the process exits.
 *
 * Not a provider plugin: there is no `LanguageModel` here and no
 * `providers.qwen-code` config slice in this package — it exists so
 * `@rivetos/boot` can register a real executor for harness id `qwen-code`.
 * Provider-plugin id (owned elsewhere) is also `qwen-code`. See
 * docs/ARCHITECTURE.md § HarnessDriver: control-plane contract.
 */

export {
  QwenCodeExecutor,
  QWEN_CODE_HARNESS_ID,
  buildTaskScaffold,
  buildTurnPrompt,
  canonicalQwenCodeSessionId,
  defaultWorkspaceDir,
  readTaskHistory,
  renderResumeTranscript,
} from './executor.js'
export type { QwenCodeExecutorConfig } from './executor.js'

export {
  KILL_GRACE_MS,
  PROMPT_MAX_BYTES,
  RESUME_REJECTED_RE,
  buildArgs,
  buildChildEnv,
  clampPrompt,
  spawnQwenTurn,
} from './spawn-turn.js'
export type { QwenSpawnFlags, SpawnedTurn } from './spawn-turn.js'

export {
  QWEN_NATIVE_RE,
  RUNTIME_TERMINAL_TYPES,
  SESSION_TYPE,
  assistantMessage,
  emptyQwenTurnFacts,
  encodeQwenCwd,
  findSessionFile,
  isFatalQwenResult,
  listSessionIds,
  parseQwenJsonLine,
  qwenHome,
  qwenProjectsRoot,
  reconcileTurn,
  resolveSessionPath,
  sessionIdFromEvent,
  streamEventInner,
  toHarnessEvents,
  toHarnessEventsFromDisk,
  tokensFromUsage,
  transcriptFilesFor,
  usageFromEvent,
} from './wire.js'
export type {
  QwenJsonEvent,
  QwenTurnEnd,
  QwenTurnFacts,
  QwenTurnUsage,
  SessionLocation,
} from './wire.js'
