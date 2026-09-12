/**
 * RivetOS memory capture plugin for OpenCode.
 *
 * Installed as a COPY at ~/.config/opencode/plugins/rivet-memory.ts.
 * Setup rewrites the PLUGIN_PATH const to the rivet-memory package root so
 * this file can spawn bin/opencode-memory-capture.sh after being copied.
 *
 * Trigger only — SQLite rows are the source of truth. Ignore message.*
 * events. Never throw into OpenCode.
 *
 * Runs under Bun. Imports: node:child_process, node:path only.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

/** Rewritten by setup-opencode-rivet-memory.sh --apply */
const PLUGIN_PATH = "/opt/rivetos/integrations/opencode/rivet-memory"

export const DEBOUNCE_MS = 1500

type PluginEvent = {
  type?: string
  properties?: {
    sessionID?: string
    sessionId?: string
  }
  sessionID?: string
}

type ChildLike = {
  exitCode?: number | null
  killed?: boolean
  unref?: () => void
  on?: (event: string, listener: (...args: unknown[]) => void) => void
}

function sessionIdOf(event: PluginEvent | null | undefined): string | null {
  if (!event || typeof event !== 'object') return null
  const fromProps = event.properties?.sessionID ?? event.properties?.sessionId
  const raw = fromProps ?? event.sessionID
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function spawnIngest(
  sessionId: string,
  inFlight: Map<string, ChildLike>,
): void {
  const existing = inFlight.get(sessionId)
  if (existing && existing.exitCode == null && existing.killed !== true) {
    return
  }
  try {
    const script = path.join(PLUGIN_PATH, 'bin', 'opencode-memory-capture.sh')
    const child: ChildLike = spawn('bash', [script, '--ingest-session', sessionId], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env },
    })
    child.unref?.()
    inFlight.set(sessionId, child)
    const clear = (): void => {
      if (inFlight.get(sessionId) === child) inFlight.delete(sessionId)
    }
    child.on?.('exit', clear)
    child.on?.('error', clear)
  } catch {
    inFlight.delete(sessionId)
  }
}

export const RivetMemory = async ({ directory: _directory }: { directory?: string }) => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlight = new Map<string, ChildLike>()

  const cancelTimer = (sessionId: string): void => {
    const t = timers.get(sessionId)
    if (t) {
      clearTimeout(t)
      timers.delete(sessionId)
    }
  }

  const ingestNow = (sessionId: string): void => {
    cancelTimer(sessionId)
    spawnIngest(sessionId, inFlight)
  }

  const scheduleIngest = (sessionId: string): void => {
    cancelTimer(sessionId)
    const t = setTimeout(() => {
      timers.delete(sessionId)
      spawnIngest(sessionId, inFlight)
    }, DEBOUNCE_MS)
    t.unref?.()
    timers.set(sessionId, t)
  }

  return {
    event: async ({ event }: { event: PluginEvent }) => {
      try {
        const type = typeof event?.type === 'string' ? event.type : ''
        if (!type || type.startsWith('message.')) return
        const sessionId = sessionIdOf(event)
        if (!sessionId) return
        if (type === 'session.idle') {
          scheduleIngest(sessionId)
          return
        }
        if (
          type === 'session.compacted' ||
          type === 'session.deleted' ||
          type === 'session.error'
        ) {
          ingestNow(sessionId)
        }
      } catch {
        // never throw into opencode
      }
    },
  }
}

export default RivetMemory
