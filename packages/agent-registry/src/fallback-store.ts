import type { AgentPreset } from '@rivetos/types'
import type {
  AgentPresetInput,
  AgentPresetPatch,
  AgentPresetStore,
  AgentRegistryBackend,
} from './store.js'

/** A hung `isReady` counts as not ready after this. Matches the preset pool's query budget. */
export const PRESET_PROBE_TIMEOUT_MS = 10_000

/**
 * One log if a fallback op is still in flight this long after a drain starts.
 * A hung local `stateDir` never settles the drain, so the primary import
 * would otherwise wait forever with no signal.
 */
const DRAIN_LIVENESS_MS = 30_000

export interface FallbackPresetStoreOptions {
  primary: AgentPresetStore
  fallback: AgentPresetStore
  /** How long a false/throwing/timed-out primary check is trusted. Default 30s. */
  recheckMs?: number
  /**
   * Bound on one `primary.isReady()` call. A timeout counts as not ready and
   * is re-checked after `recheckMs`. Default {@link PRESET_PROBE_TIMEOUT_MS}.
   */
  probeTimeoutMs?: number
  now?: () => number
  log?: (msg: string) => void
}

export interface FallbackAgentPresetStore extends AgentPresetStore {
  /**
   * Fires once the primary has answered `isReady() === true` AND in-flight
   * fallback operations have drained, including when the primary was already
   * accepted. Register synchronously after `createFallbackPresetStore` and
   * before the first `isReady`/`list`/… call: the den kicks a probe at boot
   * and must not miss the transition. Not called again if the primary was
   * already announced.
   */
  onPrimaryReady(cb: () => void): void
  /**
   * Resolves when no fallback operation is in flight. `onPrimaryReady` waits
   * on this before firing, so a legacy import cannot snapshot `agents.json`
   * while a fallback `create` is still writing it. Safe to call again.
   */
  drainFallback(): Promise<void>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`preset store primary check timed out after ${String(ms)}ms`))
    }, ms)
    void work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/**
 * Serve `primary` once `primary.isReady()` has answered true (cached forever
 * after that first true). While it answers false, throws, or times out, serve
 * `fallback` and ask again at most every `recheckMs`. `backend` and `file`
 * report the store currently in use — before the first successful check, that
 * is the fallback, so a file-mode wrapper still exposes `file` to the
 * legacy-import guard.
 *
 * A fallback operation that already chose the file store is counted until it
 * finishes. The flip stops handing out the fallback immediately (new ops go
 * to the primary) and announces readiness only after those ops drain, so a
 * write that started on the file cannot land after the importer's snapshot.
 *
 * Does not probe on its own. The caller kicks `isReady()` (the den does this
 * at boot, not awaited) after registering `onPrimaryReady`.
 */
export function createFallbackPresetStore(
  opts: FallbackPresetStoreOptions,
): FallbackAgentPresetStore {
  const primary = opts.primary
  const fallback = opts.fallback
  const recheckMs = opts.recheckMs ?? 30_000
  const probeTimeoutMs = opts.probeTimeoutMs ?? PRESET_PROBE_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const log = opts.log

  let servingPrimary = false
  let announced = false
  let lastCheck: number | undefined
  let inflight: Promise<boolean> | null = null
  let fallbackOps = 0
  let drainWarned = false
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const callbacks: Array<() => void> = []
  const drainers: Array<() => void> = []

  function clearDrainTimer(): void {
    if (drainTimer === undefined) return
    clearTimeout(drainTimer)
    drainTimer = undefined
  }

  /** Log once per hang. A later drain that settles and hangs again logs again. */
  function armDrainLiveness(): void {
    if (drainTimer !== undefined || drainWarned) return
    const timer = setTimeout(() => {
      drainTimer = undefined
      if (fallbackOps === 0 || drainWarned) return
      drainWarned = true
      log?.(
        `preset store fallback operation still in flight after ${String(DRAIN_LIVENESS_MS / 1000)}s; ` +
          'a hung stateDir is blocking the primary import',
      )
    }, DRAIN_LIVENESS_MS)
    drainTimer = timer
    if (typeof timer.unref === 'function') timer.unref()
  }

  function fireReady(): void {
    if (announced) return
    announced = true
    const pending = callbacks.splice(0)
    for (const cb of pending) {
      try {
        cb()
      } catch (err) {
        log?.(`preset store primary-ready callback failed: ${errorMessage(err)}`)
      }
    }
  }

  function onPrimaryReady(cb: () => void): void {
    if (announced) {
      try {
        cb()
      } catch (err) {
        log?.(`preset store primary-ready callback failed: ${errorMessage(err)}`)
      }
      return
    }
    callbacks.push(cb)
  }

  function beginFallback(): void {
    fallbackOps += 1
  }

  function endFallback(): void {
    fallbackOps -= 1
    if (fallbackOps === 0) {
      clearDrainTimer()
      drainWarned = false
      const pending = drainers.splice(0)
      for (const resolve of pending) resolve()
    }
  }

  function drainFallback(): Promise<void> {
    if (fallbackOps === 0) return Promise.resolve()
    armDrainLiveness()
    return new Promise((resolve) => {
      drainers.push(resolve)
    })
  }

  async function probe(): Promise<boolean> {
    try {
      // `Promise.resolve().then` so a synchronous `isReady` throw rejects the
      // promise instead of running `finally` before `inflight` is assigned.
      const ok = await withTimeout(
        Promise.resolve().then(() => primary.isReady()),
        probeTimeoutMs,
      )
      if (ok) {
        // New ops take the primary now. Announce only after fallback ops that
        // already started have finished writing.
        // Transient split-brain: this flip is visible to GET/PATCH before the
        // legacy import runs, so a legacy id 404s from Postgres until that
        // import lands. The drain here waits for in-flight file writes, not
        // for the import (the den starts that from onPrimaryReady).
        servingPrimary = true
        if (fallbackOps > 0) await drainFallback()
        fireReady()
        return true
      }
      return false
    } catch (err) {
      log?.(`preset store primary check failed: ${errorMessage(err)}`)
      return false
    } finally {
      inflight = null
    }
  }

  function startProbe(): Promise<boolean> {
    const flight = Promise.resolve().then(probe)
    inflight = flight
    return flight
  }

  function usePrimary(): Promise<boolean> {
    if (servingPrimary) return Promise.resolve(true)
    if (inflight) return inflight
    const t = now()
    if (lastCheck !== undefined && t - lastCheck < recheckMs) return Promise.resolve(false)
    lastCheck = t
    return startProbe()
  }

  /**
   * Pick the store and, when it is the fallback, hold the drain count from
   * this synchronous turn until `op` settles. The cached-not-ready path does
   * not await before `beginFallback`, so a probe cannot flip and snapshot
   * between the decision and the count.
   */
  async function run<T>(op: (store: AgentPresetStore) => Promise<T>): Promise<T> {
    if (!servingPrimary && !inflight) {
      const t = now()
      if (lastCheck !== undefined && t - lastCheck < recheckMs) {
        beginFallback()
        try {
          return await op(fallback)
        } finally {
          endFallback()
        }
      }
    }
    const ready = await usePrimary()
    if (ready || servingPrimary) return op(primary)
    beginFallback()
    try {
      return await op(fallback)
    } finally {
      endFallback()
    }
  }

  function current(): AgentPresetStore {
    return servingPrimary ? primary : fallback
  }

  return {
    get backend(): AgentRegistryBackend {
      return current().backend
    },
    get file(): string | undefined {
      return current().file
    },
    isReady(): Promise<boolean> {
      return usePrimary().then((ready) => (ready ? true : fallback.isReady()))
    },
    list(filter?: { node?: string }): Promise<AgentPreset[]> {
      return run((store) => store.list(filter))
    },
    get(id: string): Promise<AgentPreset | undefined> {
      return run((store) => store.get(id))
    },
    findByHandle(handle: string): Promise<AgentPreset | undefined> {
      return run((store) => store.findByHandle(handle))
    },
    create(input: AgentPresetInput & { id?: string; createdAt?: number }): Promise<AgentPreset> {
      return run((store) => store.create(input))
    },
    update(id: string, patch: AgentPresetPatch): Promise<AgentPreset | undefined> {
      return run((store) => store.update(id, patch))
    },
    delete(id: string): Promise<boolean> {
      return run((store) => store.delete(id))
    },
    onPrimaryReady,
    drainFallback,
  }
}
