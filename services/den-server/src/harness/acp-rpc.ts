import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { record } from './codex-rpc.js'

/**
 * Agent Client Protocol (ACP) client over one agent process's stdio:
 * newline-delimited JSON-RPC 2.0, protocol version 1. Verified against
 * `grok agent stdio` 1.0.44 and `opencode acp` 1.18.35; Gemini CLI, Hermes
 * and Copilot CLI answered the same `initialize`.
 *
 * One process serves every session of its harness (`session/new` takes a
 * per-session `cwd`). The process starts on the first request and is not
 * restarted on its own: a request that was in flight when it exited may
 * already have run, so it is rejected, never replayed, and the next request
 * starts a fresh process.
 */
export interface AcpFrame {
  method: string
  params: Record<string, unknown>
  /** Present on agent → client requests (`session/request_permission`). */
  id?: number | string
}

export interface AcpAgentInfo {
  protocolVersion: number
  agentCapabilities: Record<string, unknown>
  agentInfo?: Record<string, unknown>
}

export interface AcpRpc {
  /** Bumped on every successful `initialize`; sessions loaded under an older
   *  generation must be loaded again. */
  readonly generation: number
  readonly agent: AcpAgentInfo | undefined
  /** Start the agent and run `initialize` if it is not running. */
  connect(): Promise<void>
  /** `timeoutMs: 0` waits indefinitely — `session/prompt` lasts a whole turn. */
  request(
    method: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>
  notify(method: string, params: Record<string, unknown>): void
  respond(id: number | string, result: unknown): void
  reject(id: number | string, message: string): void
  subscribe(sink: (frame: AcpFrame) => void): () => void
  close(): void
}

export type AcpSpawn = (
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

export interface AcpClientOptions {
  argv: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  log?: (msg: string) => void
  /** Test seam. */
  spawn?: AcpSpawn
}

const DEFAULT_TIMEOUT_MS = 60_000
/** A single JSON-RPC line larger than this is a broken agent, not a message. */
const MAX_LINE_BYTES = 32 * 1024 * 1024

export class AcpClient implements AcpRpc {
  generation = 0
  agent: AcpAgentInfo | undefined
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private closed = false
  private nextId = 0
  private buffer = ''
  private readonly sinks = new Set<(frame: AcpFrame) => void>()
  private readonly pending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer?: NodeJS.Timeout
    }
  >()

  constructor(private readonly opts: AcpClientOptions) {
    if (!opts.argv.length) throw new Error('ACP agent command is empty')
  }

  subscribe(sink: (frame: AcpFrame) => void): () => void {
    this.sinks.add(sink)
    return () => {
      this.sinks.delete(sink)
    }
  }

  private emit(frame: AcpFrame): void {
    for (const sink of this.sinks) {
      try {
        sink(frame)
      } catch {
        /* isolate subscribers */
      }
    }
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('ACP connection is closed'))
    if (this.child && this.agent) return Promise.resolve()
    this.starting ??= new Promise<void>((resolve, reject) => {
      const [command, ...args] = this.opts.argv
      const child = (this.opts.spawn ?? defaultSpawn)(command, args, {
        cwd: this.opts.cwd,
        env: this.opts.env,
      })
      this.child = child
      this.buffer = ''
      // A den that exits without close() must not leave the agent behind. On
      // SIGKILL this does not run; the agent then sees stdin close and exits.
      const killOnExit = (): void => {
        child.kill()
      }
      process.once('exit', killOnExit)
      child.once('exit', () => process.removeListener('exit', killOnExit))
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.onData(child, chunk))
      // Agents log to stderr; keep only a tail for the exit message.
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000)
      })
      child.stdin.on('error', () => undefined)
      child.once('error', (error) => {
        reject(error)
      })
      child.once('exit', (code, signal) => {
        reject(new Error(`ACP agent exited during startup (${String(code ?? signal)})`))
        if (this.child !== child) return
        this.child = undefined
        this.agent = undefined
        for (const pending of this.pending.values()) {
          if (pending.timer) clearTimeout(pending.timer)
          pending.reject(new Error('ACP agent exited; request outcome may be unknown'))
        }
        this.pending.clear()
        if (!this.closed) {
          const tail = stderr.trim().split('\n').slice(-3).join(' | ')
          this.opts.log?.(
            `[den-server] acp: ${command} exited (${String(code ?? signal)})${tail ? `: ${tail}` : ''}`,
          )
        }
        this.emit({ method: '$disconnected', params: {} })
      })
      this.send('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'rivethub', title: 'RivetHub', version: '0.5.0' },
      }).then(
        (result) => {
          if (result.protocolVersion !== 1) {
            reject(new Error(`ACP agent speaks protocol ${String(result.protocolVersion)}, not 1`))
            child.kill()
            return
          }
          this.agent = {
            protocolVersion: 1,
            agentCapabilities: record(result.agentCapabilities),
            ...(result.agentInfo ? { agentInfo: record(result.agentInfo) } : {}),
          }
          this.generation++
          this.emit({ method: '$connected', params: {} })
          resolve()
        },
        (error: unknown) => {
          reject(error instanceof Error ? error : new Error('ACP initialization failed'))
          child.kill()
        },
      )
    }).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private onData(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.opts.log?.('[den-server] acp: agent sent an oversized line; restarting it')
      child.kill()
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    let value: Record<string, unknown>
    try {
      value = record(JSON.parse(line))
    } catch {
      // Some agents print a banner before switching to JSON-RPC.
      return
    }
    const id = value.id
    if (typeof value.method === 'string') {
      this.emit({
        method: value.method,
        params: record(value.params),
        ...(typeof id === 'number' || typeof id === 'string' ? { id } : {}),
      })
      return
    }
    if (typeof id !== 'number') return
    const pending = this.pending.get(id)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(id)
    if (value.error) {
      const error = record(value.error)
      const details = record(error.data).details
      pending.reject(
        new Error(
          [typeof error.message === 'string' ? error.message : 'ACP request failed', details]
            .filter((part) => typeof part === 'string' && part)
            .join(': '),
        ),
      )
    } else pending.resolve(record(value.result))
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child
    if (!child?.stdin.writable) throw new Error('ACP agent is not running')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`ACP ${method} timed out; request was not retried`))
            }, timeoutMs)
          : undefined
      timer?.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ id, method, params })
      } catch (error) {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    await this.connect()
    return this.send(method, params, opts.timeoutMs)
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params })
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result })
  }

  reject(id: number | string, message: string): void {
    try {
      this.write({ id, error: { code: -32601, message } })
    } catch {
      /* the agent is gone; nothing is waiting */
    }
  }

  close(): void {
    this.closed = true
    this.child?.kill()
    this.child = undefined
  }
}

const defaultSpawn: AcpSpawn = (command, args, opts) =>
  nodeSpawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
