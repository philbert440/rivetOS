/**
 * @rivetos/harness-pi
 *
 * The pi half of the harness control plane's task side: a
 * `HarnessExecutor` that drives the local `pi` binary headlessly
 * (`pi --print --mode json`) and reconciles the turn's usage out of stdout
 * or pi's own session jsonl after the process exits.
 *
 * Not a provider plugin: there is no `LanguageModel` here and no
 * `providers.pi-cli` config slice in this package — it exists so
 * `@rivetos/boot` can register a real executor for harness id `pi`.
 * Provider-plugin id (owned elsewhere) is `pi-cli`. See docs/ARCHITECTURE.md
 * § HarnessDriver: control-plane contract.
 */

export {
  PiExecutor,
  PI_HARNESS_ID,
  buildTaskScaffold,
  buildTurnPrompt,
  canonicalPiSessionId,
  readTaskHistory,
  renderResumeTranscript,
} from './executor.js'
export type { PiExecutorConfig } from './executor.js'

export {
  KILL_GRACE_MS,
  PROMPT_MAX_BYTES,
  RESUME_REJECTED_RE,
  buildArgs,
  buildChildEnv,
  clampPrompt,
  spawnPiTurn,
} from './spawn-turn.js'
export type { PiSpawnFlags, SpawnedTurn } from './spawn-turn.js'

export {
  PI_NATIVE_RE,
  RUNTIME_TERMINAL_TYPES,
  SESSION_TYPE,
  assistantMessageEvent,
  emptyPiTurnFacts,
  encodePiCwd,
  findSessionFile,
  isFatalPiStopReason,
  listSessionIds,
  parsePiJsonLine,
  piHome,
  reconcileTurn,
  resolveSessionDir,
  runtimeMessage,
  sessionsRoot,
  sessionIdFromEvent,
  toHarnessEvents,
  toHarnessEventsFromDisk,
  tokensFromUsage,
  transcriptFilesFor,
  usageFromEvent,
} from './wire.js'
export type { PiJsonEvent, PiTurnEnd, PiTurnFacts, PiTurnUsage, SessionLocation } from './wire.js'
