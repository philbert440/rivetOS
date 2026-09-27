/**
 * Comparison-only model of the **node-deployed** pre-v0.3 converter (the
 * copy that was running on the grokbot node), not the in-repo
 * convert-transcript.py (which now emits toolCalls). Used only by compare.ts
 * / tests — not a runtime capture export.
 *
 * That deployed converter: flatten content/output/text (not `result`), dump
 * tool_use into `[tool X]` / `[thinking]` text, keep wrappers. pull-bridge
 * then moved result → content and chopped tool_result at 4096 with an inline
 * marker. The "before" numbers are against that path.
 */
import { isRecord } from '@rivetos/capture-core'
import { recordParts, recordRole, toolResultBody } from './parse.js'

export const LEGACY_TOOL_RESULT_MAX = 4096

export interface LegacyRow {
  role: string
  content: string
  tool_name?: string
}

export function legacyNormalizeRecords(records: unknown[], opts?: { page?: boolean }): LegacyRow[] {
  const out: LegacyRow[] = []
  for (const rec of records) {
    const shrunk = opts?.page ? shrinkToolResults(rec) : rec
    const row = legacyFlatten(shrunk)
    if (row) out.push(row)
  }
  return out
}

/** pull-bridge.py shrink(): result→content, truncate at 4096 with marker. */
export function shrinkToolResults(rec: unknown): unknown {
  if (!isRecord(rec)) return rec
  const copy = structuredClone(rec)
  const msg = isRecord(copy.message) ? copy.message : copy
  const parts = isRecord(msg) && Array.isArray(msg.content) ? msg.content : null
  if (!parts) return copy
  for (const pt of parts) {
    if (!isRecord(pt) || pt.type !== 'tool_result') continue
    let body = toolResultBody(pt)
    const full = body.length
    if (full > LEGACY_TOOL_RESULT_MAX) {
      body = `${body.slice(0, LEGACY_TOOL_RESULT_MAX)}\n…[truncated ${String(full - LEGACY_TOOL_RESULT_MAX)} chars]`
    }
    delete pt.output
    delete pt.result
    delete pt.text
    pt.content = body
  }
  return copy
}

/** convert-transcript.py flatten() — ignores `result` unless shrink moved it. */
export function legacyFlatten(rec: unknown): LegacyRow | undefined {
  if (!isRecord(rec)) return undefined
  let role = recordRole(rec)
  const parts = recordParts(rec)
  const chunks: string[] = []
  const tools: string[] = []
  if (parts.length === 0) {
    const msg = isRecord(rec.message) ? rec.message : rec
    const content = isRecord(msg) ? msg.content : undefined
    if (typeof content === 'string' && content.trim()) chunks.push(content.trim())
    else if (content && !Array.isArray(content)) chunks.push(unknownToText(content))
  }
  for (const p of parts) {
    if (!isRecord(p)) {
      if (p) chunks.push(unknownToText(p))
      continue
    }
    const t = p.type
    if ((t === 'text' || t === 'output_text') && typeof p.text === 'string' && p.text) {
      chunks.push(p.text.trim())
    } else if (t === 'thinking' || t === 'reasoning' || t === 'redacted_thinking') {
      const body =
        (typeof p.thinking === 'string' && p.thinking) ||
        (typeof p.text === 'string' && p.text) ||
        ''
      if (body) chunks.push(`[thinking]\n${body}`)
    } else if (t === 'tool_use' || t === 'tool_call' || t === 'function_call') {
      const name =
        (typeof p.name === 'string' && p.name) ||
        (typeof p.toolName === 'string' && p.toolName) ||
        'tool'
      const args = 'input' in p ? p.input : (p.arguments ?? {})
      let dumped: string
      try {
        dumped = JSON.stringify(args)
      } catch {
        dumped = String(args)
      }
      tools.push(name)
      chunks.push(`[tool ${name}]\n${dumped}`)
    } else if (t === 'tool_result') {
      // Old converter only read content/output/text — not result.
      let body =
        (typeof p.content === 'string' && p.content) ||
        (typeof p.output === 'string' && p.output) ||
        (typeof p.text === 'string' && p.text) ||
        ''
      if (!body && p.content && typeof p.content !== 'string') {
        try {
          body = JSON.stringify(p.content)
        } catch {
          body = unknownToText(p.content)
        }
      }
      chunks.push(`[tool_result ${typeof p.name === 'string' ? p.name : ''}]\n${body}`)
    } else if (typeof p.text === 'string') {
      chunks.push(p.text)
    }
  }
  const text = chunks.filter(Boolean).join('\n\n')
  if (!role || !text) return undefined
  if (role === 'human') role = 'user'
  if (role === 'model' || role === 'bot') role = 'assistant'
  if (!['user', 'assistant', 'system', 'tool'].includes(role)) return undefined
  const row: LegacyRow = { role, content: text }
  if (tools.length === 1) row.tool_name = tools[0]
  return row
}

function unknownToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return JSON.stringify(value)
  }
  try {
    return JSON.stringify(value) || ''
  } catch {
    return ''
  }
}
