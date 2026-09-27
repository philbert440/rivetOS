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
  messages: CaptureMessage[]
}
export interface CaptureResult {
  ok: true
  conversation_id: string
  inserted: number
  skipped: number
}
export interface CaptureWriterOptions {
  denUrl: string
  fetch?: typeof globalThis.fetch
  spoolDir?: string
  log?: (line: string) => void
  now?: () => Date
}
export interface CaptureWriter {
  write(batch: CaptureBatch): Promise<CaptureResult | { spooled: true; file: string }>
  replay(opts?: { max?: number }): Promise<{ replayed: number; remaining: number; dead: number }>
}
