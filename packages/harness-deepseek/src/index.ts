/**
 * @rivetos/harness-deepseek
 *
 * The deepseek-harness spawn surface: interactive `dsh --profile tui`
 * (`--resume <native-id>` to reopen). dsh mints its own `session-<uuid>`;
 * this package adopts it. Capture is out-of-band (Cordis plugin) — nothing
 * here installs hooks or registers a headless `HarnessExecutor`.
 */

export {
  DeepSeekHarnessExecutor,
  DEEPSEEK_HARNESS_ID,
  canonicalDeepseekSessionId,
} from './executor.js'
export type { DeepSeekHarnessExecutorConfig } from './executor.js'

export { KILL_GRACE_MS, STDERR_CAP, buildArgs, buildChildEnv, spawnDshTui } from './spawn-turn.js'
export type { DshSpawnFlags, SpawnedTurn } from './spawn-turn.js'

export {
  DSH_ID_PREFIX,
  DSH_NATIVE_ID_RE,
  adoptFreshSessionId,
  dshHome,
  isDshNativeId,
  listSessionIds,
  listSessions,
  resolveSessionDir,
  sessionsRoot,
} from './sessions.js'
export type { DshSessionRef } from './sessions.js'
