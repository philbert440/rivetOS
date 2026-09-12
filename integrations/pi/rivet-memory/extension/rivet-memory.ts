/**
 * rivet-memory pi extension — RivetOS capture trigger.
 *
 * Copied to ~/.pi/agent/extensions/rivet-memory.ts by setup-pi-rivet-memory.sh.
 * The PLUGIN_PATH assignment below is rewritten to the plugin install path.
 * Dependency-free: node:child_process + node:path only. Never throws into pi.
 *
 * Terminal events (agent_end, session_shutdown, session_before_switch,
 * session_info_changed) spawn immediately. turn_end may debounce 1.5s; a
 * terminal event cancels that timer and spawns now. The parent never waits
 * on the child: spawn(detached, stdio ignore) + unref() and return.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

// setup-pi-rivet-memory.sh --apply rewrites this line.
const PLUGIN_PATH = '/opt/rivetos/integrations/pi/rivet-memory'

const DEBOUNCE_MS = 1500

type Pi = {
  on: (event: string, handler: (...args: unknown[]) => void) => void
}

type SessionCtx = {
  sessionManager?: {
    getSessionFile?: () => unknown
    getSessionId?: () => unknown
  }
}

type ChildHandle = {
  unref: () => void
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sessionFileFromCtx(...args: unknown[]): string | null {
  for (const arg of args) {
    if (!isRecord(arg)) continue
    const manager = arg.sessionManager
    if (!isRecord(manager) || typeof manager.getSessionFile !== 'function') continue
    try {
      const file = (manager as SessionCtx['sessionManager'])?.getSessionFile?.()
      if (typeof file === 'string' && file.length > 0) return file
    } catch {
      return null
    }
  }
  return null
}

function spawnIngest(sessionFile: string): ChildHandle | null {
  const pluginPath = PLUGIN_PATH
  if (!pluginPath) return null
  const script = path.join(pluginPath, 'bin', 'pi-memory-capture.sh')
  const child = spawn('bash', [script, '--ingest-file', sessionFile], {
    stdio: 'ignore',
    detached: true,
    env: process.env,
  })
  // an asynchronous 'error' (ENOENT/EAGAIN) with no listener would throw into pi
  child.on('error', () => {})
  return child as unknown as ChildHandle
}

export default function (pi: Pi): void {
  try {
    if (!pi || typeof pi.on !== 'function') return

    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const spawnNow = (file: string): void => {
      const timer = timers.get(file)
      if (timer) {
        clearTimeout(timer)
        timers.delete(file)
      }
      let child: ChildHandle | null = null
      try {
        child = spawnIngest(file)
      } catch {
        child = null
      }
      if (!child) return
      try {
        child.unref()
      } catch {
        // ignore
      }
    }

    const schedule = (file: string): void => {
      const prev = timers.get(file)
      if (prev) clearTimeout(prev)
      timers.set(
        file,
        setTimeout(() => {
          timers.delete(file)
          try {
            spawnNow(file)
          } catch {
            // never throw into pi
          }
        }, DEBOUNCE_MS),
      )
    }

    const onDebounced = (...args: unknown[]): void => {
      try {
        const file = sessionFileFromCtx(...args)
        if (!file) return
        schedule(file)
      } catch {
        // never throw into pi
      }
    }

    const onFlush = (...args: unknown[]): void => {
      try {
        const file = sessionFileFromCtx(...args)
        if (!file) return
        spawnNow(file)
      } catch {
        // never throw into pi
      }
    }

    pi.on('turn_end', onDebounced)
    pi.on('agent_end', onFlush)
    pi.on('session_shutdown', onFlush)
    pi.on('session_before_switch', onFlush)
    pi.on('session_info_changed', onFlush)
  } catch {
    // never throw into pi
  }
}
