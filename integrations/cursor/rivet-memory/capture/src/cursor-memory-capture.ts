#!/usr/bin/env node
/**
 * Cursor memory capture — ingest lifecycle hook payloads into RivetOS memory.
 *
 * The hook (`bin/rivet-memory-hook.sh`) spools each payload under
 * ~/.rivetos/cursor-capture/spool/ and, when this file is built, pipes the
 * raw payload to `--hook <event>`. `--backfill` walks that spool. Both paths
 * are idempotent: event ids are stable, and the den skips ids already stored.
 *
 * Identity: agent='rivet-cursor', channel='cursor',
 * session_key='cursor:<conversation_id>'.
 *
 * Best-effort in `--hook` mode (always exits 0). `--backfill` exits 1 when
 * the transport is missing or a batch is rejected.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  asString,
  createCaptureWriter,
  isRecord,
  loadEnvFile,
  resolveCaptureTransport,
  resolveDenUrl,
} from '@rivetos/capture-core'
import type { CaptureBatch, CaptureMessage, CaptureWriterOptions } from '@rivetos/capture-core'

export const CAPTURE_AGENT = 'rivet-cursor'
export const CAPTURE_CHANNEL = 'cursor'
export const CONTENT_LIMIT = 16_000

const USAGE = `cursor-rivet-memory-capture — ingest Cursor hook payloads into RivetOS memory
  cursor-rivet-memory-capture --hook <event>     read one payload from stdin
  cursor-rivet-memory-capture --backfill [--spool DIR]
  cursor-rivet-memory-capture --status
`

export interface SpoolEvent {
  event: string
  payload: Record<string, unknown>
  createdAt?: string
  file?: string
}

export interface IngestCounts {
  files: number
  conversations: number
  inserted: number
  skipped: number
  spooled: number
  failed: number
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function capText(text: string): { text: string; truncated: boolean; fullLength: number } {
  if (text.length <= CONTENT_LIMIT) return { text, truncated: false, fullLength: text.length }
  const charCode = text.charCodeAt(CONTENT_LIMIT - 1)
  const cut = CONTENT_LIMIT - (charCode >= 0xd800 && charCode <= 0xdbff ? 1 : 0)
  return { text: text.slice(0, cut), truncated: true, fullLength: text.length }
}

/** `20260927T175058Z` (hook stamp) or an ISO timestamp → ISO-8601 with a Z offset. */
export function spoolStampToIso(stamp: string | undefined): string | undefined {
  if (!stamp) return undefined
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  const iso = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}.000Z`
    : stamp
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return undefined
  return new Date(parsed).toISOString()
}

export function readSpoolRecord(raw: unknown, file?: string): SpoolEvent | null {
  if (!isRecord(raw)) return null
  if (isRecord(raw.payload)) {
    const event = asString(raw.hook) ?? asString(raw.payload.hook_event_name)
    if (!event) return null
    return {
      event,
      payload: raw.payload,
      createdAt: spoolStampToIso(asString(raw.ts) ?? undefined),
      file,
    }
  }
  const event = asString(raw.hook_event_name)
  if (!event) return null
  return { event, payload: raw, file }
}

function conversationId(payload: Record<string, unknown>): string | null {
  return asString(payload.conversation_id) ?? asString(payload.session_id)
}

function sessionKeyFor(conversation: string): string {
  return `cursor:${conversation}`
}

function stringList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items.slice(0, max) : undefined
}

function baseMetadata(event: SpoolEvent, extra: Record<string, unknown>): Record<string, unknown> {
  const payload = event.payload
  const metadata: Record<string, unknown> = {
    source: 'cursor-hook',
    hook: event.event,
    ...extra,
  }
  const model = asString(payload.model)
  const version = asString(payload.cursor_version)
  const generation = asString(payload.generation_id)
  const transcript = asString(payload.transcript_path)
  const roots = stringList(payload.workspace_roots, 8)
  if (model) metadata.model = model
  if (version) metadata.cursor_version = version
  if (generation) metadata.generation_id = generation
  if (transcript) metadata.transcript_path = transcript
  if (roots) metadata.workspace_roots = roots
  return metadata
}

function message(parts: {
  event: SpoolEvent
  role: CaptureMessage['role']
  content: string
  nativeId: string
  kind: string
  toolName?: string
  toolArgs?: unknown
  toolResult?: string
  resultLength?: number
  extra?: Record<string, unknown>
}): CaptureMessage {
  const conversation = conversationId(parts.event.payload)
  if (!conversation) throw new Error('cursor capture message without a conversation id')
  const capped = capText(parts.content)
  const metadata = baseMetadata(parts.event, { native_event_id: parts.nativeId, ...parts.extra })
  if (capped.truncated) {
    metadata.truncated = true
    metadata.full_content_length = capped.fullLength
  }
  let toolResult: string | undefined
  if (parts.toolResult !== undefined) {
    const cappedResult = capText(parts.toolResult)
    toolResult = cappedResult.text
    if (cappedResult.truncated) {
      metadata.truncated = true
      metadata.full_tool_result_length = parts.resultLength ?? cappedResult.fullLength
    }
  }
  return {
    event_id: `${sessionKeyFor(conversation)}:${parts.kind}:${parts.nativeId}`,
    role: parts.role,
    content: capped.text,
    metadata,
    ...(parts.event.createdAt ? { created_at: parts.event.createdAt } : {}),
    ...(parts.toolName ? { tool_name: parts.toolName } : {}),
    ...(parts.toolArgs !== undefined ? { tool_args: parts.toolArgs } : {}),
    ...(toolResult !== undefined ? { tool_result: toolResult } : {}),
  }
}

function toolOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** Map one Cursor hook event to zero or more memory rows. Stable ids, no email. */
export function messagesFromCursorEvent(event: SpoolEvent): CaptureMessage[] {
  const payload = event.payload
  if (!conversationId(payload)) return []
  switch (event.event) {
    case 'beforeSubmitPrompt': {
      const prompt = asString(payload.prompt)
      if (!prompt) return []
      const generation = asString(payload.generation_id) ?? 'none'
      const attachments = Array.isArray(payload.attachments) ? payload.attachments.length : 0
      return [
        message({
          event,
          role: 'user',
          content: prompt,
          kind: 'user',
          nativeId: `${generation}:${sha256(prompt).slice(0, 12)}`,
          ...(attachments > 0 ? { extra: { attachment_count: attachments } } : {}),
        }),
      ]
    }
    case 'afterAgentResponse': {
      const text = asString(payload.text)
      if (!text) return []
      const generation = asString(payload.generation_id) ?? 'none'
      return [
        message({
          event,
          role: 'assistant',
          content: text,
          kind: 'assistant',
          nativeId: `${generation}:${sha256(text).slice(0, 12)}`,
        }),
      ]
    }
    case 'postToolUse': {
      const toolName = asString(payload.tool_name) ?? 'tool'
      const toolUseId = asString(payload.tool_use_id)
      const result = toolOutput(payload.tool_output)
      const nativeId = toolUseId ?? sha256(`${toolName}\0${result}`).slice(0, 16)
      return [
        message({
          event,
          role: 'tool',
          content: toolName,
          kind: 'tool',
          nativeId,
          toolName,
          toolArgs: payload.tool_input,
          toolResult: result,
        }),
      ]
    }
    case 'sessionEnd': {
      const reason = asString(payload.reason) ?? asString(payload.final_status) ?? 'completed'
      return [
        message({
          event,
          role: 'system',
          content: `[cursor.sessionEnd] ${reason}`,
          kind: 'sessionEnd',
          nativeId: 'end',
        }),
      ]
    }
    case 'subagentStop': {
      const summary =
        asString(payload.summary) ?? asString(payload.result) ?? asString(payload.text)
      const status = asString(payload.status) ?? 'completed'
      const subId =
        asString(payload.subagent_id) ??
        asString(payload.agent_id) ??
        asString(payload.tool_use_id) ??
        sha256(summary ?? status).slice(0, 12)
      return [
        message({
          event,
          role: summary ? 'assistant' : 'system',
          content: summary ?? `[cursor.subagentStop] ${status}`,
          kind: 'subagent',
          nativeId: subId,
        }),
      ]
    }
    default:
      return []
  }
}

function titleFrom(messages: CaptureMessage[]): string | undefined {
  const user = messages.find((row) => row.role === 'user')
  if (!user) return undefined
  const collapsed = user.content.replace(/\s+/g, ' ').trim()
  return collapsed.length > 0 ? collapsed.slice(0, 120) : undefined
}

function settingsFrom(events: SpoolEvent[], conversation: string): Record<string, unknown> {
  const settings: Record<string, unknown> = { source: 'cursor-hook', conversationId: conversation }
  for (const event of events) {
    const model = asString(event.payload.model)
    const version = asString(event.payload.cursor_version)
    const transcript = asString(event.payload.transcript_path)
    const roots = stringList(event.payload.workspace_roots, 8)
    if (model && model !== 'default') settings.model = model
    if (version) settings.cursor_version = version
    if (transcript) settings.transcript_path = transcript
    if (roots) settings.workspace_roots = roots
  }
  return settings
}

/** Group spool events into one batch per conversation, in time order. */
export function batchesFromEvents(events: SpoolEvent[]): CaptureBatch[] {
  const ordered = [...events].sort((a, b) => {
    const stamp = (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    if (stamp !== 0) return stamp
    return (a.file ?? '').localeCompare(b.file ?? '')
  })
  const groups = new Map<
    string,
    { events: SpoolEvent[]; messages: CaptureMessage[]; finalize: boolean }
  >()
  for (const event of ordered) {
    const conversation = conversationId(event.payload)
    if (!conversation) continue
    const messages = messagesFromCursorEvent(event)
    const finalize = event.event === 'sessionEnd'
    if (messages.length === 0 && !finalize) continue
    const key = sessionKeyFor(conversation)
    const group = groups.get(key) ?? { events: [], messages: [], finalize: false }
    group.events.push(event)
    group.messages.push(...messages)
    group.finalize = group.finalize || finalize
    groups.set(key, group)
  }
  const batches: CaptureBatch[] = []
  for (const [sessionKey, group] of groups) {
    const seen = new Set<string>()
    const messages = group.messages.filter((row) => {
      if (seen.has(row.event_id)) return false
      seen.add(row.event_id)
      return true
    })
    const conversation = sessionKey.slice('cursor:'.length)
    const title = titleFrom(messages)
    batches.push({
      session_key: sessionKey,
      agent: CAPTURE_AGENT,
      channel: CAPTURE_CHANNEL,
      ...(title ? { title } : {}),
      settings: settingsFrom(group.events, conversation),
      ...(group.finalize ? { finalize: true } : {}),
      messages,
    })
  }
  return batches
}

export function fetchWithCa(caPath: string | undefined): typeof fetch {
  let ca: string | undefined
  if (caPath) {
    try {
      ca = fs.readFileSync(caPath, 'utf8')
    } catch {
      ca = undefined
    }
  }
  if (!ca) return globalThis.fetch
  const trusted = ca
  return (input, init) =>
    new Promise((resolve, reject) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (!url.startsWith('https:')) {
        resolve(globalThis.fetch(input, init))
        return
      }
      const body = typeof init?.body === 'string' ? init.body : undefined
      const headers: Record<string, string> = {}
      const headerInit = init?.headers
      if (isRecord(headerInit)) {
        for (const [key, value] of Object.entries(headerInit)) {
          if (typeof value === 'string') headers[key] = value
        }
      }
      const req = https.request(
        url,
        { method: init?.method, headers, ca: trusted, timeout: 20_000 },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const flat: Record<string, string> = {}
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === 'string') flat[key] = value
              else if (Array.isArray(value)) flat[key] = value.join(', ')
            }
            resolve(
              new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: flat }),
            )
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error('den capture timeout')))
      req.on('error', reject)
      req.end(body)
    })
}

export async function ingestBatches(
  batches: CaptureBatch[],
  sink: Partial<CaptureWriterOptions> = {},
): Promise<IngestCounts> {
  const counts: IngestCounts = {
    files: 0,
    conversations: batches.length,
    inserted: 0,
    skipped: 0,
    spooled: 0,
    failed: 0,
  }
  if (batches.length === 0) return counts
  const transport = resolveCaptureTransport(process.env)
  if (transport.kind === 'none') throw new Error(transport.reason)
  if (transport.kind === 'pg') {
    throw new Error(
      'cursor capture writes through the den; RIVETOS_CAPTURE_TRANSPORT=pg is not supported',
    )
  }
  const den = resolveDenUrl(process.env)
  const writer = createCaptureWriter({
    ...sink,
    denUrl: transport.denUrl,
    fetch: sink.fetch ?? fetchWithCa(den?.caPath),
    log: sink.log ?? ((line) => console.error(line)),
  })
  for (const batch of batches) {
    try {
      const result = await writer.write(batch)
      if ('spooled' in result) {
        if (result.spooled) counts.spooled += 1
        else {
          counts.failed += 1
          console.error(`ingest failed ${batch.session_key}: ${result.error}`)
        }
        continue
      }
      counts.inserted += result.inserted
      counts.skipped += result.skipped
    } catch (error) {
      counts.failed += 1
      console.error(
        `ingest failed ${batch.session_key}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return counts
}

export function loadSpoolDir(dir: string): { events: SpoolEvent[]; unreadable: number } {
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch (error) {
    throw new Error(`spool unreadable: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  const events: SpoolEvent[] = []
  let unreadable = 0
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const record = readSpoolRecord(JSON.parse(fs.readFileSync(file, 'utf8')), name)
      if (record) events.push(record)
      else unreadable += 1
    } catch {
      unreadable += 1
    }
  }
  return { events, unreadable }
}

function applyHouseEnv(): void {
  const file = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  for (const [key, value] of Object.entries(loadEnvFile(file))) {
    if (!process.env[key]) process.env[key] = value
  }
}

function asBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) return chunk
  return Buffer.alloc(0)
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) chunks.push(asBytes(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function printCounts(label: string, counts: IngestCounts): void {
  console.log(
    `${label} files=${counts.files} conversations=${counts.conversations} inserted=${counts.inserted} skipped=${counts.skipped} spooled=${counts.spooled} failed=${counts.failed}`,
  )
}

async function main(): Promise<void> {
  applyHouseEnv()
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return
  }
  if (args[0] === '--status') {
    const transport = resolveCaptureTransport(process.env)
    console.log(`transport=${transport.kind} agent=${CAPTURE_AGENT} channel=${CAPTURE_CHANNEL}`)
    return
  }
  if (args[0] === '--hook') {
    const event = args[1] || 'unknown'
    try {
      const text = (await readStdin()).trim()
      const parsed: unknown = text ? JSON.parse(text) : {}
      const record = readSpoolRecord(
        isRecord(parsed) && isRecord(parsed.payload)
          ? parsed
          : { hook_event_name: event, ...(isRecord(parsed) ? parsed : {}) },
      )
      const spoolEvent: SpoolEvent = record ?? { event, payload: {} }
      if (!record) spoolEvent.event = event
      const batches = batchesFromEvents([spoolEvent])
      if (batches.length === 0) {
        console.log(`ingest skipped event=${event}`)
        return
      }
      const counts = await ingestBatches(batches)
      counts.files = 1
      printCounts('ingest', counts)
    } catch (error) {
      console.error(`ingest error: ${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }
  if (args[0] === '--backfill') {
    const spoolFlag = args.indexOf('--spool')
    const dir =
      spoolFlag >= 0 && args[spoolFlag + 1]
        ? args[spoolFlag + 1]
        : path.join(os.homedir(), '.rivetos', 'cursor-capture', 'spool')
    const loaded = loadSpoolDir(dir)
    const batches = batchesFromEvents(loaded.events)
    const counts = await ingestBatches(batches)
    counts.files = loaded.events.length
    counts.failed += loaded.unreadable
    printCounts('backfill', counts)
    if (counts.failed > 0) process.exitCode = 1
    return
  }
  console.log(USAGE)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(process.argv.includes('--hook') ? 0 : 1)
  })
}
