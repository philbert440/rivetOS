/**
 * @rivetos/harness-opencode
 *
 * The opencode half of the harness control plane's task side: a
 * `HarnessExecutor` that drives the local `opencode` binary headlessly
 * (`opencode run --format json`) and reconciles the turn's usage out of
 * opencode.db after the process exits.
 *
 * Not a provider plugin: there is no `LanguageModel` here and no
 * `providers.opencode` config slice — the package exists so `@rivetos/boot`
 * can register a real executor for harness id `opencode`. See
 * docs/ARCHITECTURE.md § HarnessDriver: control-plane contract.
 */

export {
  OpencodeExecutor,
  OPENCODE_HARNESS_ID,
  buildTaskScaffold,
  buildTurnPrompt,
  canonicalOpencodeSessionId,
  readTaskHistory,
  renderResumeTranscript,
} from './executor.js'
export type { OpencodeExecutorConfig } from './executor.js'

export {
  KILL_GRACE_MS,
  PROMPT_MAX_BYTES,
  RESUME_REJECTED_RE,
  buildArgs,
  buildChildEnv,
  clampPrompt,
  spawnOpencodeTurn,
  variantForEffort,
} from './spawn-turn.js'
export type { OpencodeSpawnFlags, OpencodeStreamLine, SpawnedTurn } from './spawn-turn.js'

export {
  emptyWireTurnFacts,
  listSessionIds,
  newestSessionAfter,
  opencodeDbPath,
  opencodeHome,
  effectiveOpencodeHome,
  parseOpencodeEvent,
  reconcileTurn,
  xdgDataHomeFor,
} from './wire.js'
export type {
  ParsedOpencodeEvent,
  ParsedOpencodeKind,
  SessionIndexEntry,
  WireTurnEnd,
  WireTurnFacts,
  WireTurnUsage,
} from './wire.js'
