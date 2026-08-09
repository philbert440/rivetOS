/**
 * @rivetos/harness-kimi-code
 *
 * The kimi-code half of the harness control plane's task side: a
 * `HarnessExecutor` that drives the local `kimi` binary headlessly
 * (`kimi -p --output-format stream-json`) and reconciles the turn's usage out
 * of kimi's own `wire.jsonl` after the process exits.
 *
 * Not a provider plugin: there is no `LanguageModel` here and no
 * `providers.kimi-code` config slice — the package exists so `@rivetos/boot`
 * can register a real executor for harness id `kimi-code` where #476 could
 * only register an honest rejection. See docs/plans/harness-control-plane.md
 * § As built (kimi-code task executor).
 */

export {
  KimiCodeExecutor,
  KIMI_HARNESS_ID,
  buildTaskScaffold,
  buildTurnPrompt,
  canonicalKimiSessionId,
  readTaskHistory,
  renderResumeTranscript,
} from './executor.js'
export type { KimiCodeExecutorConfig } from './executor.js'

export {
  KILL_GRACE_MS,
  PROMPT_MAX_BYTES,
  RESUME_HINT_TYPE,
  RESUME_REJECTED_RE,
  buildArgs,
  buildChildEnv,
  clampPrompt,
  spawnKimiTurn,
} from './spawn-turn.js'
export type {
  KimiAssistantLine,
  KimiMetaLine,
  KimiSpawnFlags,
  KimiStreamLine,
  KimiToolCall,
  KimiToolLine,
  SpawnedTurn,
} from './spawn-turn.js'

export {
  findBucketDir,
  kimiHome,
  listSessionIds,
  readSessionIndex,
  reconcileTurn,
  resolveSessionDir,
  sessionsRoot,
  wireFilesFor,
  workDirHash,
} from './wire.js'
export type { SessionIndexEntry, WireTurnEnd, WireTurnFacts, WireTurnUsage } from './wire.js'
