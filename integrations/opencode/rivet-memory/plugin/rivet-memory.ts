/**
 * RivetOS memory capture plugin for OpenCode.
 *
 * Installed as a COPY at ~/.config/opencode/plugins/rivet-memory.ts.
 * Setup rewrites the PLUGIN_PATH const to the rivet-memory package root so
 * this file can spawn bin/opencode-memory-capture.sh after being copied.
 *
 * Trigger only — SQLite rows are the source of truth; message.* events are
 * ignored. Terminal session events spawn the ingester IMMEDIATELY (detached,
 * unref'd) so a short-lived `opencode run` cannot exit before a timer fires;
 * the child owns the coalescing (`--delay-ms`) and a cross-process state lock,
 * so several quick spawns for one session serialize and dedup to no-ops.
 * Never throw into OpenCode.
 *
 * Runs under Bun. Imports: node:child_process, node:path only. This module
 * exports ONLY plugin functions — OpenCode's loader rejects other exports.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

/** Rewritten by setup-opencode-rivet-memory.sh --apply */
const PLUGIN_PATH = '/opt/rivetos/integrations/opencode/rivet-memory'

/** Child-side coalescing window (ms) passed as --delay-ms. */
const CHILD_DELAY_MS = 1500
/** Parent-side per-session rate limit (ms): identical events inside this window collapse. */
const RATE_LIMIT_MS = 200

const TERMINAL_EVENTS = new Set([
  'session.idle',
  'session.compacted',
  'session.deleted',
  'session.error',
])

type PluginEvent = {
  type?: string
  properties?: {
    sessionID?: string
    sessionId?: string
  }
  sessionID?: string
}

function sessionIdOf(event: PluginEvent | null | undefined): string | null {
  if (!event || typeof event !== 'object') return null
  const fromProps = event.properties?.sessionID ?? event.properties?.sessionId
  const raw = fromProps ?? event.sessionID
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function spawnIngest(sessionId: string): void {
  try {
    const script = path.join(PLUGIN_PATH, 'bin', 'opencode-memory-capture.sh')
    const child = spawn(
      'bash',
      [script, '--ingest-session', sessionId, '--delay-ms', String(CHILD_DELAY_MS)],
      { stdio: 'ignore', detached: true, env: { ...process.env } },
    )
    child.unref()
  } catch {
    // never throw into opencode
  }
}

export const RivetMemory = async ({ directory: _directory }: { directory?: string }) => {
  const lastSpawn = new Map<string, number>()
  return {
    event: async ({ event }: { event: PluginEvent }) => {
      try {
        const type = typeof event?.type === 'string' ? event.type : ''
        if (!TERMINAL_EVENTS.has(type)) return
        const sessionId = sessionIdOf(event)
        if (!sessionId) return
        const now = Date.now()
        const prev = lastSpawn.get(sessionId)
        if (prev !== undefined && now - prev < RATE_LIMIT_MS) return
        lastSpawn.set(sessionId, now)
        spawnIngest(sessionId)
      } catch {
        // never throw into opencode
      }
    },
  }
}

export default RivetMemory
