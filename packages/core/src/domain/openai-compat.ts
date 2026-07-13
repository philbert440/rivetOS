/**
 * OpenAI-compatible `/v1/*` surface for den-server (gateway mount).
 *
 * Mirrors the on-device Rivet bridge (`rivet-bridge-server-v2.js`) so Android
 * (and any OpenAI client) can treat a RivetOS node as a drop-in backend:
 *
 *   GET  /v1/models              agent id → model id
 *   POST /v1/chat/completions    last user message → gateway turn
 *
 * Session mapping (node holds context — do NOT replay history):
 *   1. `x-rivet-conversation` header (bridge convention)
 *   2. OpenAI body `user` field
 *   3. else a fresh random id (one-shot)
 *
 * StreamEvent → SSE chunk mapping matches the bridge:
 *   text       → delta.content
 *   reasoning  → delta.reasoning_content
 *   tool_*     → delta.rivet_tools (never OpenAI tool_calls)
 *   status     → rivet_status on the frame (empty delta)
 *   done       → finish_reason "stop" then data: [DONE]
 *   error      → OpenAI-shaped error frame then end
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GatewayRoute, MessageUsage, StreamEvent } from '@rivetos/types'
import type { GatewayChannelHandle } from './gateway-channel.js'
import { logger } from '../logger.js'

const log = logger('OpenAICompat')

const MAX_BODY_BYTES = 256 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OpenAICompatOptions {
  /** Same agent list `/api/catalog/agents` uses (agent id = model id). */
  listAgents: () => Promise<Array<{ id: string }>>
  /** Gateway channel that owns sessions + the turn pipeline. */
  gateway: Pick<GatewayChannelHandle, 'submitTurn'>
  defaultAgent?: string
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      req.pause()
      throw new Error('body too large')
    }
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/** Bridge: non-UUID conversation keys hash to a stable UUID. */
export function uuidFromString(s: string): string {
  const h = createHash('sha256')
    .update(s || 'rivet')
    .digest('hex')
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '4' + h.slice(13, 16),
    ((parseInt(h[16], 16) & 3) | 8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-')
}

export function normalizeConversationId(raw: string): string {
  const s = raw.trim()
  if (!s) return randomUUID()
  return UUID_RE.test(s) ? s.toLowerCase() : uuidFromString(s)
}

/**
 * Session / channel id for a completions request.
 * Header → body.user → fresh UUID (one-shot; node still owns the ring entry).
 */
export function resolveConversationId(req: IncomingMessage, body: Record<string, unknown>): string {
  const hdr = String(req.headers['x-rivet-conversation'] ?? '').trim()
  if (hdr) return normalizeConversationId(hdr)
  if (typeof body.user === 'string' && body.user.trim()) return normalizeConversationId(body.user)
  return randomUUID()
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object') {
          const o = c as { text?: unknown; content?: unknown }
          if (typeof o.text === 'string') return o.text
          if (typeof o.content === 'string') return o.content
        }
        return ''
      })
      .join('')
  }
  if (content == null) return ''
  if (typeof content === 'number' || typeof content === 'boolean' || typeof content === 'bigint')
    return String(content)
  return ''
}

/** Bridge: only the last user message's text — node holds prior context. */
export function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: unknown = messages[i]
    if (m && typeof m === 'object' && (m as { role?: unknown }).role === 'user') {
      return textOf((m as { content?: unknown }).content)
    }
  }
  return ''
}

function usageToOpenAI(usage?: MessageUsage): Record<string, number> | undefined {
  if (!usage) return undefined
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
  }
}

function chatCmplId(): string {
  return 'chatcmpl-' + randomBytes(8).toString('hex')
}

/** Map one StreamEvent to OpenAI SSE payload pieces (or null to skip). */
export function streamEventToChunkParts(event: StreamEvent): {
  delta?: Record<string, unknown>
  extra?: Record<string, unknown>
  finish?: string | null
  error?: { message: string }
  done?: boolean
} | null {
  switch (event.type) {
    case 'text':
      return { delta: { content: event.content } }
    case 'reasoning':
      return { delta: { reasoning_content: event.content } }
    case 'tool_start': {
      const meta = event.metadata ?? {}
      const id =
        typeof meta.id === 'string'
          ? meta.id
          : typeof meta.toolCallId === 'string'
            ? meta.toolCallId
            : event.content || randomUUID()
      const name = typeof meta.tool === 'string' ? meta.tool : event.content || 'tool'
      const args = meta.args ?? meta.arguments ?? meta.input
      return {
        delta: {
          rivet_tools: [
            {
              id,
              name,
              ...(args !== undefined ? { arguments: args } : {}),
            },
          ],
        },
      }
    }
    case 'tool_result': {
      const meta = event.metadata ?? {}
      const id =
        typeof meta.id === 'string'
          ? meta.id
          : typeof meta.toolCallId === 'string'
            ? meta.toolCallId
            : event.content || randomUUID()
      const output =
        typeof meta.output === 'string'
          ? meta.output
          : typeof meta.result === 'string'
            ? meta.result
            : event.content
      return { delta: { rivet_tools: [{ id, output }] } }
    }
    case 'status':
      return { delta: {}, extra: { rivet_status: event.content } }
    case 'interrupt':
      return { delta: {}, extra: { rivet_status: event.content || 'interrupted' } }
    case 'done':
      return { delta: {}, finish: 'stop', done: true }
    case 'error':
      return { error: { message: event.content || 'stream error' } }
    default:
      return null
  }
}

export function createOpenAICompatRoute(opts: OpenAICompatOptions): GatewayRoute {
  return {
    prefix: '/v1',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sub = url.pathname.slice('/v1'.length).replace(/^\//, '')

        if (sub === 'models') {
          if (req.method !== 'GET')
            return json(res, 405, { error: { message: 'method not allowed' } })
          const agents = await opts.listAgents()
          return json(res, 200, {
            object: 'list',
            data: agents.map((a) => ({
              id: a.id,
              object: 'model',
              created: 0,
              owned_by: 'rivetos',
            })),
          })
        }

        if (sub === 'chat/completions') {
          if (req.method !== 'POST')
            return json(res, 405, { error: { message: 'method not allowed' } })
          const body = await readJsonBody(req).catch((err: unknown) => {
            json(res, (err as Error).message === 'body too large' ? 413 : 400, {
              error: { message: (err as Error).message },
            })
            return null
          })
          if (body === null) return
          if (body === undefined) return json(res, 400, { error: { message: 'bad json' } })

          const text = lastUserText(body.messages)
          if (!text.trim())
            return json(res, 400, { error: { message: 'messages must include a user turn' } })

          const agents = await opts.listAgents()
          const requested = typeof body.model === 'string' ? body.model : ''
          const model =
            (requested && agents.some((a) => a.id === requested) && requested) ||
            opts.defaultAgent ||
            agents[0]?.id ||
            requested ||
            'default'

          const conv = resolveConversationId(req, body)
          const stream = body.stream === true
          const id = chatCmplId()
          const created = Math.floor(Date.now() / 1000)

          const THINK = ['off', 'low', 'medium', 'high', 'xhigh'] as const
          const effort = (body as { reasoning_effort?: unknown }).reasoning_effort
          const thinkingRaw =
            typeof body.thinking === 'string'
              ? body.thinking
              : typeof effort === 'string'
                ? effort
                : undefined
          const thinking =
            thinkingRaw && (THINK as readonly string[]).includes(thinkingRaw)
              ? (thinkingRaw as (typeof THINK)[number])
              : undefined

          if (!stream) {
            const result = await opts.gateway.submitTurn({
              sessionId: conv,
              text,
              agent: model,
              thinking,
              userId: typeof body.user === 'string' ? body.user : undefined,
            })
            if (!result.ok) return json(res, result.status, { error: { message: result.error } })
            const usage = usageToOpenAI(result.message.usage)
            return json(res, 200, {
              id,
              object: 'chat.completion',
              created,
              model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: result.message.text },
                  finish_reason: 'stop',
                },
              ],
              ...(usage ? { usage } : {}),
              rivet_conversation: conv,
            })
          }

          // ---- SSE streaming (OpenAI chunk frames) ----
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          const writeChunk = (
            delta: Record<string, unknown>,
            finish: string | null = null,
            extra?: Record<string, unknown>,
          ): void => {
            const payload = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: finish }],
              rivet_conversation: conv,
              ...extra,
            }
            res.write('data: ' + JSON.stringify(payload) + '\n\n')
          }

          writeChunk({ role: 'assistant', content: '' }, null)

          // Mutable bag so closure updates are visible to control-flow after await.
          const st = {
            emittedText: false,
            sawDone: false,
            streamError: undefined as string | undefined,
          }

          const onStream = (event: StreamEvent): void => {
            if (st.sawDone || st.streamError) return
            const parts = streamEventToChunkParts(event)
            if (!parts) return
            if (parts.error) {
              st.streamError = parts.error.message
              res.write(
                'data: ' +
                  JSON.stringify({
                    error: { message: st.streamError, type: 'server_error' },
                  }) +
                  '\n\n',
              )
              return
            }
            if (parts.delta && Object.keys(parts.delta).length > 0) {
              if (typeof parts.delta.content === 'string' && parts.delta.content)
                st.emittedText = true
              writeChunk(parts.delta, parts.finish ?? null, parts.extra)
            } else if (parts.extra || parts.finish) {
              writeChunk(parts.delta ?? {}, parts.finish ?? null, parts.extra)
            }
            if (parts.done) st.sawDone = true
          }

          const result = await opts.gateway.submitTurn({
            sessionId: conv,
            text,
            agent: model,
            thinking,
            userId: typeof body.user === 'string' ? body.user : undefined,
            onStream,
          })

          if (st.streamError) {
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }

          if (!result.ok) {
            if (!st.emittedText) {
              writeChunk({ content: `[agent error: ${result.error.slice(0, 200)}]` }, null)
            }
            if (!st.sawDone) writeChunk({}, 'stop')
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }

          // Non-streaming providers only deliver via the final message.
          if (!st.emittedText && result.message.text) {
            writeChunk({ content: result.message.text }, null)
          }

          if (!st.sawDone) {
            const usage = usageToOpenAI(result.message.usage)
            writeChunk({}, 'stop', usage ? { usage } : undefined)
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        return json(res, 404, { error: { message: `not found: /v1/${sub}` } })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`openai compat error: ${msg}`)
        if (!res.headersSent) json(res, 500, { error: { message: msg } })
        else {
          try {
            res.end()
          } catch {
            /* ignore */
          }
        }
      }
    },
  }
}
