/**
 * memory_get_full — fetch the complete, untruncated payload for a captured
 * row whose content/tool_result was elided at capture time (issue #197).
 *
 * Capture truncates at 16K but records a disk pointer
 * (metadata.session_jsonl_path + session_jsonl_line) back to the source
 * updates.jsonl. This tool re-reads that line and re-derives the full text.
 * No re-ingest, no DB write — just a disk read.
 *
 * The tool accepts ONLY a row id. The disk path always comes from the row's
 * own metadata (written by our capture worker), never from the caller — an
 * MCP tool must not be a generic read-any-file primitive.
 *
 * The JSONL parsing below (extractText / formatToolResult / byte-array
 * handling) is a thin duplicate of the capture worker's logic — keep in sync
 * with integrations/grok/rivet-memory/capture/src/grok-memory-capture.ts.
 */

import { createInterface } from 'node:readline'
import { createReadStream, existsSync } from 'node:fs'
import pg from 'pg'
import type { Tool } from '@rivetos/types'

const PREVIEW_GUARD = 512 * 1024 // sanity cap on what we return in one call

// --- thin duplicates of capture-worker parsing (keep in sync) --------------

function bytesToString(arr: number[]): string {
  try {
    return Buffer.from(arr).toString('utf8')
  } catch {
    return `[${String(arr.length)} bytes]`
  }
}

function stripByteArrays(obj: unknown, depth = 0): unknown {
  if (depth > 6 || obj == null) return obj
  if (Array.isArray(obj)) {
    const looksLikeBytes =
      obj.length >= 16 &&
      obj.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)
    if (looksLikeBytes) return bytesToString(obj as number[])
    return obj.map((v) => stripByteArrays(v, depth + 1))
  }
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = stripByteArrays(v, depth + 1)
    }
    return out
  }
  return obj
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-plus-operands */

function extractText(content: any): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (Array.isArray(content))
    return content
      .map((c) => extractText(c))
      .filter(Boolean)
      .join('\n')
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
  }
  return ''
}

function formatToolResult(update: any): string | null {
  const out = update?.rawOutput
  if (out && typeof out === 'object') {
    const t = out.type
    if (t === 'Bash') {
      if (typeof out.output_for_prompt === 'string') {
        const tail = `exit_code=${out.exit_code ?? '?'}${out.timed_out ? ' timed_out=true' : ''}${out.truncated ? ' truncated=true' : ''}`
        return `${out.output_for_prompt}\n[${tail}]`
      }
    } else if (t === 'GrepSearch') {
      if (typeof out.output_for_prompt === 'string') return out.output_for_prompt
      if (Array.isArray(out.stdout)) return bytesToString(out.stdout)
    } else if (t === 'ReadFile') {
      if (typeof out.FileContent?.content === 'string') return out.FileContent.content
    } else if (t === 'SearchTool') {
      if (typeof out.content === 'string') {
        const prefix =
          typeof out.result_count === 'number' ? `[result_count=${String(out.result_count)}]\n` : ''
        return prefix + out.content
      }
    } else if (t === 'MCP') {
      const header = `[mcp ${out.server_name ?? '?'}/${out.tool_name ?? '?'}]`
      const o = out.output
      if (typeof o === 'string') return `${header}\n${o}`
      if (typeof o?.OkayOutput === 'string') return `${header}\n${o.OkayOutput}`
      if (typeof o?.ErrorOutput === 'string') return `${header} ERROR\n${o.ErrorOutput}`
      try {
        return `${header}\n${JSON.stringify(stripByteArrays(o))}`
      } catch {
        /* fall through */
      }
    } else if (t === 'ListDir') {
      if (typeof out.Content?.content === 'string') return out.Content.content
    } else if (t === 'Todo') {
      if (typeof out.TodosUpdated?.summary_for_prompt === 'string') {
        return out.TodosUpdated.summary_for_prompt
      }
    }
    try {
      return JSON.stringify(stripByteArrays(out))
    } catch {
      /* fall through */
    }
  }
  return null
}

// --- disk access -------------------------------------------------------------

/** Read a single 0-indexed line from a (potentially large) file without
 *  loading the whole thing. */
async function readJsonlLine(file: string, lineIndex: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    let i = 0
    rl.on('line', (line) => {
      if (i === lineIndex) {
        rl.close()
        resolve(line)
      }
      i++
    })
    rl.on('close', () => {
      if (i <= lineIndex) resolve(null)
    })
    rl.on('error', reject)
  })
}

/** Parse one updates.jsonl line and derive the full content + tool result.
 *  Exported for tests. */
export function extractFullFromLine(raw: string): { content: string; toolResult: string | null } {
  let j: any
  try {
    j = JSON.parse(raw)
  } catch {
    return { content: '', toolResult: null }
  }
  const update = j?.params?.update ?? j?.update ?? j
  const text = extractText(update?.content)
  const content = update?.sessionUpdate === 'agent_thought_chunk' ? `[thinking] ${text}` : text
  return { content, toolResult: formatToolResult(update) }
}

/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-plus-operands */

// --- the tool ----------------------------------------------------------------

interface FullRow {
  id: string
  content: string
  tool_name: string | null
  tool_result: string | null
  metadata: Record<string, unknown> | null
}

export function createGetFullTool(pool: pg.Pool): Tool {
  return {
    name: 'memory_get_full',
    description:
      'Fetch the complete, untruncated payload for a memory row whose content or tool_result ' +
      'was elided at capture time (rows marked "…[truncated]" by memory_search/memory_browse). ' +
      'Reads the original line back from the capture JSONL on disk.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Row id, as shown by memory_search / memory_browse truncation hints',
        },
      },
      required: ['id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const id = typeof args.id === 'string' ? args.id : ''
      if (!id) return 'memory_get_full: id is required (string).'

      let row: FullRow | undefined
      try {
        const res = await pool.query<FullRow>(
          `SELECT id, content, tool_name, tool_result, metadata
           FROM ros_messages WHERE id = $1`,
          [id],
        )
        row = res.rows[0]
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        return `memory_get_full failed: ${msg}`
      }
      if (!row) return `No message with id ${id}.`

      const meta = row.metadata ?? {}
      if (meta.truncated !== true) {
        // nothing was elided — the stored row already IS the full payload
        const tool = row.tool_name ? `\n\n[tool: ${row.tool_name}]\n${row.tool_result ?? ''}` : ''
        return `(row was not truncated — stored payload is complete)\n\n${row.content}${tool}`
      }

      const file = typeof meta.session_jsonl_path === 'string' ? meta.session_jsonl_path : null
      const line = typeof meta.session_jsonl_line === 'number' ? meta.session_jsonl_line : null
      if (!file || line === null)
        return (
          'Row is truncated but carries no disk pointer (pre-#196 capture, or a non-grok source) — ' +
          'the elided tail is unrecoverable.'
        )
      if (!file.endsWith('.jsonl') || !existsSync(file))
        return `Source JSONL is gone or invalid (${file}) — the elided tail is unrecoverable.`

      let raw: string | null
      try {
        raw = await readJsonlLine(file, line)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        return `Failed reading ${file}:${String(line)}: ${msg}`
      }
      if (raw === null)
        return `Line ${String(line)} not found in ${file} (file rotated/rewritten?).`

      const { content, toolResult } = extractFullFromLine(raw)
      const sections: string[] = [`## Full payload for ${id} (from ${file}:${String(line)})`]
      if (typeof meta.full_content_length === 'number' && content) {
        sections.push(
          `### content (${String(content.length)} chars)\n${content.slice(0, PREVIEW_GUARD)}`,
        )
      }
      if (typeof meta.full_tool_result_length === 'number' && toolResult) {
        sections.push(
          `### tool_result${row.tool_name ? ` (${row.tool_name})` : ''} (${String(toolResult.length)} chars)\n${toolResult.slice(0, PREVIEW_GUARD)}`,
        )
      }
      if (sections.length === 1)
        return `Re-read ${file}:${String(line)} but could not re-derive the elided field — the line shape may have changed.`
      return sections.join('\n\n')
    },
  }
}
