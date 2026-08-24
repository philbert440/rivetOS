/**
 * DeepSeekHarnessExecutor — TUI spawn + native-id adoption.
 *
 * Not a `HarnessExecutor`. dsh has no `--session-id` pin and no stream-json
 * task protocol wired in this PR (`HARNESS_EXECUTOR_GAPS['deepseek-harness']`).
 * The den term manager owns the interactive PTY; this class is the spawn
 * surface tests and any future headless wiring share:
 *
 *   - argv is `dsh --profile tui [--resume <native-id>]`
 *   - the native id is whatever the CLI mints (`session-<uuid>`)
 *   - no hook-fed capture (Cordis plugin is out-of-band)
 *
 * Adoption, not pinning: same contract as
 * `packages/harness-kimi-code/src/executor.ts` ("kimi has no --session-id,
 * so the id is whatever the CLI mints").
 */

import type { HarnessId } from '@rivetos/types'
import { formatSessionId, isSessionId } from '@rivetos/types'
import { createLogger, type HarnessLogger } from './log.js'
import { adoptFreshSessionId, listSessionIds } from './sessions.js'
import { spawnDshTui, type SpawnedTurn } from './spawn-turn.js'

/** Harness id this surface registers under (`HARNESS_IDS`). */
export const DEEPSEEK_HARNESS_ID: HarnessId = 'deepseek-harness'

export interface DeepSeekHarnessExecutorConfig {
  /** Absolute path to the `dsh` binary. */
  binary: string
  /**
   * Default working directory. Pins the cwd-slug bucket under DSH_HOME.
   * spec/roster cwd overrides.
   */
  cwd?: string
  /** DSH_HOME for the child AND for on-disk id adoption. Default: `~/.dsh`. */
  dshHome?: string
  /** Override the SIGTERM→SIGKILL grace (tests use a short one). */
  killGraceMs?: number
}

/**
 * Canonicalize dsh's native `session-<uuid>` onto the control plane's one id
 * format, `deepseek-harness:session-<uuid>`.
 *
 * Adoption, not pinning: dsh has no `--session-id`, so the id is whatever the
 * CLI minted. An id already carrying a prefix, or one the codec rejects,
 * passes through verbatim — a non-canonical breadcrumb beats none.
 */
export function canonicalDeepseekSessionId(nativeId: string | undefined): string | undefined {
  if (nativeId === undefined || nativeId === '') return undefined
  if (isSessionId(nativeId)) return nativeId
  try {
    return formatSessionId(DEEPSEEK_HARNESS_ID, nativeId)
  } catch {
    return nativeId
  }
}

export class DeepSeekHarnessExecutor {
  readonly name = DEEPSEEK_HARNESS_ID
  private readonly cfg: DeepSeekHarnessExecutorConfig
  private readonly log: HarnessLogger

  constructor(cfg: DeepSeekHarnessExecutorConfig) {
    this.cfg = cfg
    this.log = createLogger('deepseek-harness-executor')
  }

  /**
   * Spawn a fresh TUI (`dsh --profile tui`). Snapshot session ids first so
   * the caller can adopt whatever the CLI minted after the process exits or
   * the session dir appears.
   */
  spawnFresh(opts?: { cwd?: string }): { spawned: SpawnedTurn; idsBefore: Set<string> } {
    return this.spawn({ cwd: opts?.cwd })
  }

  /** Reopen an existing native session (`dsh --profile tui --resume <id>`). */
  resume(nativeSessionId: string, opts?: { cwd?: string }): SpawnedTurn {
    return this.spawn({ cwd: opts?.cwd, resumeSessionId: nativeSessionId }).spawned
  }

  /**
   * The session a fresh spawn created, when exactly one new id appeared
   * under DSH_HOME. Ambiguous (0 or 2+) → undefined.
   */
  adoptMintedId(idsBefore: Set<string>): string | undefined {
    return adoptFreshSessionId(idsBefore, this.cfg.dshHome)
  }

  private spawn(opts: { cwd?: string; resumeSessionId?: string }): {
    spawned: SpawnedTurn
    idsBefore: Set<string>
  } {
    const cwd = opts.cwd ?? this.cfg.cwd ?? process.cwd()
    const idsBefore =
      opts.resumeSessionId === undefined ? listSessionIds(this.cfg.dshHome) : new Set<string>()
    const spawned = spawnDshTui(
      {
        binary: this.cfg.binary,
        cwd,
        resumeSessionId: opts.resumeSessionId,
      },
      {
        killGraceMs: this.cfg.killGraceMs,
        env: {
          // Out-of-band capture (Cordis) inherits this env. Drop a surrounding
          // den terminal's key so TUI turns do not file into that room.
          RIVETOS_SESSION_KEY: undefined,
          ...(this.cfg.dshHome ? { DSH_HOME: this.cfg.dshHome } : {}),
        },
      },
    )
    this.log.info('tui.spawn', {
      pid: spawned.proc.pid,
      resume: opts.resumeSessionId ?? null,
    })
    return { spawned, idsBefore }
  }
}
