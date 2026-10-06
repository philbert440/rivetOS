export type CaptureRole = 'system' | 'user' | 'assistant' | 'tool'
export interface CaptureMessage {
  event_id: string
  role: CaptureRole
  content: string
  tool_name?: string
  tool_args?: unknown
  tool_result?: string
  metadata?: Record<string, unknown>
  created_at?: string
}
export interface CaptureBatch {
  session_key: string
  agent: string
  channel?: string
  title?: string
  settings?: Record<string, unknown>
  task_id?: string
  finalize?: boolean
  /**
   * Source timestamps (metadata `createdAt` / `lastActivityAt`), not ingest
   * time. ISO with an offset. On insert they win over `now()`; on conflict
   * `updated_at` only moves forward.
   */
  created_at?: string
  updated_at?: string
  messages: CaptureMessage[]
}
export interface CaptureResult {
  ok: true
  conversation_id: string
  inserted: number
  skipped: number
}
/** Opt-in capture redaction. Absent or `enabled: false` leaves bytes unchanged. */
export interface CaptureRedactionOptions {
  enabled?: boolean
  /** Built-in secret shapes. Default true when enabled. */
  builtins?: boolean
  /** Extra JS regex source strings (global flag applied). */
  patterns?: string[]
}

export interface CaptureWriterOptions {
  denUrl: string
  /**
   * The routed user this session was spawned for (`RIVETOS_USER_ID` and
   * `RIVETOS_USER_TOKEN`). The token is sent to the den, which writes the
   * batch to that user's store; the spool is that user's own directory.
   * Left out: read from this process's environment (and a routed session
   * without a token throws). `null`: the node owner, whatever the environment.
   */
  user?: { id: string; token: string } | null
  fetch?: typeof globalThis.fetch
  spoolDir?: string
  log?: (line: string) => void
  now?: () => Date
  /** UTF-8 byte budget of one posted JSON body. Default 768 KiB. */
  maxChunkBytes?: number
  /**
   * Optional redaction at the write point. When omitted (or set without an
   * `enabled` key), `RIVETOS_CAPTURE_REDACTION` may enable built-ins via
   * `captureRedactionFromEnv`. Explicit `enabled: false` disables even if the
   * env is set; explicit `enabled: true` uses these options.
   */
  redaction?: CaptureRedactionOptions
}
export interface CaptureWriter {
  write(
    batch: CaptureBatch,
  ): Promise<
    | CaptureResult
    | { spooled: true; file: string; files: string[] }
    | { spooled: false; error: string }
  >
  replay(opts?: { max?: number }): Promise<{ replayed: number; remaining: number; dead: number }>
}
