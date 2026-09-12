/**
 * rivet-memory pi extension — RivetOS capture trigger.
 *
 * Copied to ~/.pi/agent/extensions/rivet-memory.ts by setup-pi-rivet-memory.sh.
 * The PLUGIN_PATH assignment below is rewritten to the plugin install path.
 * Dependency-free: node:child_process + node:path only. Never throws into pi.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

// setup-pi-rivet-memory.sh --apply rewrites this line.
const PLUGIN_PATH = "/opt/rivetos/integrations/pi/rivet-memory"

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
  on: (event: string, cb: (...args: unknown[]) => void) => unknown
  unref: () => void
}

type FileSlot = {
  timer: ReturnType<typeof setTimeout> | null
  child: ChildHandle | null
  pending: boolean
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
  }) as unknown as ChildHandle
  return child
}

export default function (pi: Pi): void {
  try {
    if (!pi || typeof pi.on !== 'function') return

    const slots = new Map<string, FileSlot>()

    const slotFor = (file: string): FileSlot => {
      let slot = slots.get(file)
      if (!slot) {
        slot = { timer: null, child: null, pending: false }
        slots.set(file, slot)
      }
      return slot
    }

    const run = (file: string): void => {
      const slot = slotFor(file)
      if (slot.timer) {
        clearTimeout(slot.timer)
        slot.timer = null
      }
      if (slot.child) {
        slot.pending = true
        return
      }
      slot.pending = false
      let child: ChildHandle | null = null
      try {
        child = spawnIngest(file)
      } catch {
        child = null
      }
      if (!child) return
      slot.child = child
      const done = (): void => {
        slot.child = null
        if (slot.pending) {
          slot.pending = false
          run(file)
        }
      }
      try {
        child.on('exit', done)
        child.on('error', done)
      } catch {
        slot.child = null
      }
      try {
        child.unref()
      } catch {
        // ignore
      }
    }

    const schedule = (file: string): void => {
      const slot = slotFor(file)
      if (slot.timer) clearTimeout(slot.timer)
      slot.timer = setTimeout(() => {
        slot.timer = null
        try {
          run(file)
        } catch {
          // never throw into pi
        }
      }, DEBOUNCE_MS)
    }

    const flush = (file: string): void => {
      try {
        run(file)
      } catch {
        // never throw into pi
      }
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
        flush(file)
      } catch {
        // never throw into pi
      }
    }

    pi.on('turn_end', onDebounced)
    pi.on('agent_end', onDebounced)
    pi.on('session_shutdown', onFlush)
    pi.on('session_before_switch', onFlush)
    pi.on('session_info_changed', onFlush)
  } catch {
    // never throw into pi
  }
}
