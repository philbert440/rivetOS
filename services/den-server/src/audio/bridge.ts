// MicBridge — exclusive publisher lock + FIFO sink for host→node PCM.
//
// Path A (default): raw s16le frames are written into a named FIFO that a
// drop-in `pw-record` shim (scripts/micbridge-phase0) reads and emits on
// stdout. That makes Grok Build's Linux capture path treat the RivetHub
// host mic as a local device without PipeWire or /dev/snd.
//
// The bridge never requires kernel sound. Callers (WS /audio/mic) acquire,
// write PCM, and release; concurrent publishers are rejected with "busy".

import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export type AudioBackend = 'fifo-shim' | 'none'

export interface MicBridgeConfig {
  /** Runtime directory for FIFO + audit log. */
  dir: string
  /** Logical device name reported to clients / status. */
  deviceName: string
  /** Default sample rate (Hz). */
  sampleRate: number
  /** Channels (mono only for v1). */
  channels: number
  /** Format label (v1: s16le only). */
  format: 's16le'
  log?: (msg: string) => void
  now?: () => number
}

export interface MicBridgeStatus {
  enabled: true
  backend: AudioBackend
  device: string
  sampleRate: number
  channels: number
  format: 's16le'
  fifoPath: string
  armed: boolean
  publisherId: string | null
  armedAt: number | null
  bytesWritten: number
  /** True when the FIFO exists (mkfifo succeeded). */
  runtimeReady: boolean
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; code: 'busy'; publisherId: string }
  | { ok: false; code: 'no-runtime'; message: string }

export class MicBridge {
  readonly fifoPath: string
  readonly auditPath: string
  private publisherId: string | null = null
  private armedAt: number | null = null
  private bytesWritten = 0
  private fd: number | null = null
  private readonly log: (msg: string) => void
  private readonly now: () => number

  constructor(private readonly cfg: MicBridgeConfig) {
    this.fifoPath = join(cfg.dir, 'mic.pcm')
    this.auditPath = join(cfg.dir, 'audit.log')
    this.log = cfg.log ?? (() => undefined)
    this.now = cfg.now ?? Date.now
  }

  /** Create dir + FIFO if missing. Idempotent. */
  ensureRuntime(): { ok: true } | { ok: false; message: string } {
    try {
      mkdirSync(this.cfg.dir, { recursive: true, mode: 0o700 })
      if (!existsSync(this.fifoPath)) {
        // Node has no mkfifo; use system mkfifo.
        const r = spawnSync('mkfifo', ['-m', '600', this.fifoPath], { encoding: 'utf8' })
        if (r.status !== 0) {
          const msg = (r.stderr || r.stdout || 'mkfifo failed').trim()
          return { ok: false, message: msg || 'mkfifo failed' }
        }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  status(): MicBridgeStatus {
    return {
      enabled: true,
      backend: existsSync(this.fifoPath) ? 'fifo-shim' : 'none',
      device: this.cfg.deviceName,
      sampleRate: this.cfg.sampleRate,
      channels: this.cfg.channels,
      format: this.cfg.format,
      fifoPath: this.fifoPath,
      armed: this.publisherId !== null,
      publisherId: this.publisherId,
      armedAt: this.armedAt,
      bytesWritten: this.bytesWritten,
      runtimeReady: existsSync(this.fifoPath),
    }
  }

  acquire(publisherId: string, meta?: { remote?: string }): AcquireResult {
    if (this.publisherId && this.publisherId !== publisherId) {
      return { ok: false, code: 'busy', publisherId: this.publisherId }
    }
    const rt = this.ensureRuntime()
    if (!rt.ok) return { ok: false, code: 'no-runtime', message: rt.message }

    if (this.publisherId === publisherId) return { ok: true }

    this.publisherId = publisherId
    this.armedAt = this.now()
    this.bytesWritten = 0
    this.openWriter()
    this.audit('arm', publisherId, meta?.remote)
    this.log(`[micbridge] armed publisher=${publisherId}`)
    return { ok: true }
  }

  release(publisherId: string, meta?: { remote?: string }): void {
    if (this.publisherId !== publisherId) return
    const heldMs = this.armedAt != null ? this.now() - this.armedAt : 0
    this.closeWriter()
    this.audit('disarm', publisherId, meta?.remote, { heldMs, bytes: this.bytesWritten })
    this.log(`[micbridge] disarmed publisher=${publisherId} heldMs=${heldMs}`)
    this.publisherId = null
    this.armedAt = null
  }

  /** Write PCM for the active publisher. Drops if not armed or no writer. */
  writePcm(publisherId: string, buf: Buffer): boolean {
    if (this.publisherId !== publisherId || !buf.length) return false
    if (this.fd === null) this.openWriter()
    if (this.fd === null) return false
    try {
      const n = writeSync(this.fd, buf)
      this.bytesWritten += n
      return n > 0
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      // No reader yet / would block — drop frame (dictation will start later).
      if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK' || err.code === 'EPIPE') {
        this.closeWriter()
        return false
      }
      this.log(`[micbridge] write error: ${err.message}`)
      this.closeWriter()
      return false
    }
  }

  close(): void {
    if (this.publisherId) this.release(this.publisherId)
    this.closeWriter()
  }

  private openWriter(): void {
    if (this.fd !== null) return
    try {
      // O_RDWR | O_NONBLOCK: do not block waiting for a reader; keep FIFO open.
      this.fd = openSync(
        this.fifoPath,
        constants.O_RDWR | constants.O_NONBLOCK,
      )
    } catch (e) {
      this.log(
        `[micbridge] open fifo failed: ${e instanceof Error ? e.message : String(e)}`,
      )
      this.fd = null
    }
  }

  private closeWriter(): void {
    if (this.fd === null) return
    try {
      closeSync(this.fd)
    } catch {
      /* ignore */
    }
    this.fd = null
  }

  private audit(
    action: string,
    publisherId: string,
    remote?: string,
    extra?: Record<string, unknown>,
  ): void {
    try {
      mkdirSync(this.cfg.dir, { recursive: true })
      const line = JSON.stringify({
        ts: new Date(this.now()).toISOString(),
        action,
        publisherId,
        remote: remote ?? null,
        ...extra,
      })
      appendFileSync(this.auditPath, line + '\n', { mode: 0o600 })
    } catch {
      /* audit best-effort */
    }
  }
}

/** Test helper: bridge under a fresh temp dir. */
export function createTestMicBridge(
  overrides: Partial<MicBridgeConfig> = {},
): MicBridge {
  const dir = overrides.dir ?? mkdtempSync(join(process.cwd(), 'micbridge-'))
  return new MicBridge({
    dir,
    deviceName: 'RivetHub Mic',
    sampleRate: 16000,
    channels: 1,
    format: 's16le',
    ...overrides,
  })
}
