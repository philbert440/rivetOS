import type { AgentPreset } from '@rivetos/types'
import type {
  AgentPresetInput,
  AgentPresetPatch,
  AgentPresetStore,
  AgentRegistryBackend,
} from './store.js'

export interface FallbackPresetStoreOptions {
  primary: AgentPresetStore
  fallback: AgentPresetStore
  /** How long a false/throwing primary check is trusted. Default 30s. */
  recheckMs?: number
  now?: () => number
  log?: (msg: string) => void
}

export interface FallbackAgentPresetStore extends AgentPresetStore {
  /**
   * Fires once the primary has answered `isReady() === true`, including when
   * it already has. Register synchronously after `createFallbackPresetStore`
   * and before the first `isReady`/`list`/… call: the den kicks a probe at
   * boot and must not miss the transition. Not called again if the primary
   * was already accepted.
   */
  onPrimaryReady(cb: () => void): void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Serve `primary` once `primary.isReady()` has answered true (cached forever
 * after that first true). While it answers false or throws, serve `fallback`
 * and ask again at most every `recheckMs`. `backend` and `file` report the
 * store currently in use — before the first successful check, that is the
 * fallback, so a file-mode wrapper still exposes `file` to the legacy-import
 * guard.
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
  const now = opts.now ?? Date.now
  const log = opts.log

  let primaryReady = false
  let lastCheck: number | undefined
  let inflight: Promise<boolean> | null = null
  let fired = false
  const callbacks: Array<() => void> = []

  function fireReady(): void {
    if (fired) return
    fired = true
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
    if (primaryReady) {
      try {
        cb()
      } catch (err) {
        log?.(`preset store primary-ready callback failed: ${errorMessage(err)}`)
      }
      return
    }
    callbacks.push(cb)
  }

  async function probe(): Promise<boolean> {
    try {
      const ok = await primary.isReady()
      if (ok) {
        primaryReady = true
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

  function usePrimary(): Promise<boolean> {
    if (primaryReady) return Promise.resolve(true)
    if (inflight) return inflight
    const t = now()
    if (lastCheck !== undefined && t - lastCheck < recheckMs) return Promise.resolve(false)
    lastCheck = t
    inflight = probe()
    return inflight
  }

  async function active(): Promise<AgentPresetStore> {
    return (await usePrimary()) ? primary : fallback
  }

  function current(): AgentPresetStore {
    return primaryReady ? primary : fallback
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
    async list(filter?: { node?: string }): Promise<AgentPreset[]> {
      return (await active()).list(filter)
    },
    async get(id: string): Promise<AgentPreset | undefined> {
      return (await active()).get(id)
    },
    async findByHandle(handle: string): Promise<AgentPreset | undefined> {
      return (await active()).findByHandle(handle)
    },
    async create(
      input: AgentPresetInput & { id?: string; createdAt?: number },
    ): Promise<AgentPreset> {
      return (await active()).create(input)
    },
    async update(id: string, patch: AgentPresetPatch): Promise<AgentPreset | undefined> {
      return (await active()).update(id, patch)
    },
    async delete(id: string): Promise<boolean> {
      return (await active()).delete(id)
    },
    onPrimaryReady,
  }
}
