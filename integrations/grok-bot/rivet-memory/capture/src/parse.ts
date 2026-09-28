import { isRecord } from '@rivetos/capture-core'
import type { InputFormat, PageHeader, ParsedInput } from './types.js'

const PAGE_HEADER_RE =
  /^Transcript of (?:agent "(?<name>.*)" \((?<id>[0-9a-f-]{36})\)|this conversation),\s*positions\s+(?<a>\d+)\s*[–—-]\s*(?<b>\d+)\s+of\s+(?<total>\d+):?\s*$/

const PAGE_FOOTER_RE = /Older messages remain:.*before=(\d+)/

export function detectFormat(text: string): InputFormat {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (PAGE_HEADER_RE.test(line)) return 'page'
    if (line.startsWith('{')) return 'ondisk'
    break
  }
  return 'ondisk'
}

export function parsePageHeader(line: string): PageHeader | undefined {
  const m = PAGE_HEADER_RE.exec(line.trim())
  if (!m?.groups) return undefined
  return {
    name: m.groups.name,
    id: m.groups.id,
    a: Number(m.groups.a),
    b: Number(m.groups.b),
    total: Number(m.groups.total),
    thisConversation: !m.groups.id,
  }
}

export function parseInput(text: string, format?: InputFormat): ParsedInput {
  const resolved = format ?? detectFormat(text)
  if (resolved === 'page') return parsePage(text)
  return parseOndisk(text)
}

function parseOndisk(text: string): ParsedInput {
  const records: unknown[] = []
  const sourceLines: number[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      records.push(JSON.parse(line) as unknown)
    } catch {
      records.push({ role: 'assistant', message: { content: [] } })
    }
    sourceLines.push(i)
  }
  return { format: 'ondisk', records, hasOlderFooter: false, sourceLines }
}

function parsePage(text: string): ParsedInput {
  let header: PageHeader | undefined
  const records: unknown[] = []
  const sourceLines: number[] = []
  let hasOlderFooter = false
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const hdr = parsePageHeader(line)
    if (hdr && !header) {
      header = hdr
      continue
    }
    if (PAGE_FOOTER_RE.test(line) && !line.startsWith('{')) {
      hasOlderFooter = true
      continue
    }
    if (line.startsWith('{')) {
      records.push(JSON.parse(line) as unknown)
      sourceLines.push(i)
    }
  }
  if (!header) {
    throw new Error(
      'ReadTranscript page is missing a "Transcript of ... positions A–B of N:" header',
    )
  }
  const expected = header.b - header.a + 1
  if (expected !== records.length) {
    throw new Error(
      `ReadTranscript header says ${String(expected)} records (${String(header.a)}–${String(header.b)}) but page has ${String(records.length)} JSON lines`,
    )
  }
  return { format: 'page', header, records, hasOlderFooter, sourceLines }
}

export function recordRole(rec: unknown): string {
  if (!isRecord(rec)) return ''
  const role = typeof rec.role === 'string' ? rec.role : ''
  const msg = isRecord(rec.message) ? rec.message : rec
  const inner = isRecord(msg) && typeof msg.role === 'string' ? msg.role : ''
  return role || inner
}

export function recordParts(rec: unknown): unknown[] {
  if (!isRecord(rec)) return []
  const msg = isRecord(rec.message) ? rec.message : rec
  const content = isRecord(msg) ? msg.content : undefined
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

export function partText(part: unknown): string {
  if (typeof part === 'string') return part
  if (!isRecord(part)) return ''
  const t = part.type
  if (t === 'text' || t === 'output_text') {
    return typeof part.text === 'string' ? part.text : ''
  }
  if (t === 'thinking' || t === 'reasoning' || t === 'redacted_thinking') {
    const body =
      (typeof part.thinking === 'string' && part.thinking) ||
      (typeof part.text === 'string' && part.text) ||
      ''
    return body ? `[thinking] ${body}` : ''
  }
  if (t === 'image' || t === 'image_url') return '[Image]'
  if (typeof part.text === 'string') return part.text
  return ''
}

export function toolResultBody(part: unknown): string {
  if (!isRecord(part)) return ''
  const body = firstNonEmpty(part, ['result', 'content', 'output', 'text'])
  if (body === undefined) return ''
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body)
  } catch {
    if (typeof body === 'number' || typeof body === 'boolean') return JSON.stringify(body)
    return ''
  }
}

function firstNonEmpty(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}
