import { createHash } from 'node:crypto'

export interface HashableMessage {
  id: string
  conversation_id: string
  role: string
  content: string
  tool_name: string | null
  tool_args: unknown
  tool_result: string | null
  created_at: Date
  access_count: number
  metadata: Record<string, unknown>
}

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function metaNumber(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function conversationStateHash(rows: readonly HashableMessage[]): string {
  const payload = [...rows]
    .map((row) => ({
      id: row.id,
      conversation_id: row.conversation_id,
      role: row.role,
      content: row.content,
      tool_name: row.tool_name,
      tool_args: row.tool_args ?? null,
      tool_result: row.tool_result,
      created_at: row.created_at.toISOString(),
      access_count: row.access_count,
      position: metaNumber(row.metadata, 'position'),
      ordinal: metaNumber(row.metadata, 'ordinal'),
      event_id: metaString(row.metadata, 'event_id'),
      capture_source: metaString(row.metadata, 'capture_source'),
      source_id: metaString(row.metadata, 'source_id'),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}
