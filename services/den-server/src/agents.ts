/**
 * Agent presets (/api/agents/*) — named agent configurations that can be
 * applied to sessions. Each preset holds model, effort level, optional
 * system prompt, and optional color swatch for UI display.
 *
 *   GET    /api/agents           list all agent presets
 *   POST   /api/agents           {name, color?, model?, effort?, systemPrompt?} → agent
 *   GET    /api/agents/:id       get one agent preset
 *   PATCH  /api/agents/:id       update agent preset
 *   DELETE /api/agents/:id       delete agent preset
 *
 * Storage is a simple JSON file in stateDir (agents.json), similar to
 * mesh-devices but without the cross-node locking complexity. Mutations
 * serialize through an in-process queue so concurrent RMW cannot drop writes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SYSTEM_PROMPT_MAX_CHARS, type AgentPreset } from '@rivetos/types'

// ---------------------------------------------------------------------------
// helpers

const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const NODE_IMMUTABLE = 'node is immutable; recreate the agent'

function isEffortLevel(value: string): value is AgentPreset['effort'] {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAgentPreset(value: unknown): value is AgentPreset {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.color === 'string' &&
    typeof value.model === 'string' &&
    typeof value.effort === 'string' &&
    isEffortLevel(value.effort) &&
    typeof value.systemPrompt === 'string' &&
    typeof value.nodeBaseUrl === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  )
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.length > 0
  } catch {
    return false
  }
}

function parseColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const color = value.trim()
  if (color === '') return ''
  if (!COLOR_RE.test(color)) return undefined
  return color
}

/**
 * In-process promise-chain mutex. Serializes registry RMW so two tabs
 * cannot drop each other's writes. Same shape as mesh-devices.
 */
function makeMutex(): <T>(fn: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => {},
      () => {},
    )
    return run
  }
}

// ---------------------------------------------------------------------------
// storage

interface Registry {
  agents: AgentPreset[]
}

function quarantineCorrupt(file: string, reason: string): Registry {
  const dest = `${file}.corrupt-${Date.now()}`
  try {
    if (existsSync(file)) renameSync(file, dest)
    console.warn(`[den-server] agents.json ${reason}; quarantined to ${dest}`)
  } catch (err) {
    console.warn(
      `[den-server] agents.json ${reason}; quarantine rename failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return { agents: [] }
}

function loadRegistry(file: string): Registry {
  if (!existsSync(file)) return { agents: [] }
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(raw) || !Array.isArray(raw.agents)) {
      return quarantineCorrupt(file, 'shape invalid')
    }
    return { agents: raw.agents.filter(isAgentPreset) }
  } catch {
    return quarantineCorrupt(file, 'parse failed')
  }
}

function saveRegistry(file: string, reg: Registry): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// routes

const readJson = (req: IncomingMessage, limit = 64 * 1024): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer | string) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += buf.length
      if (size > limit) reject(new Error('body too large'))
      else chunks.push(buf)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export interface AgentsRoutes {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
}

export function createAgentsRoutes(opts: { stateDir: string; now?: () => number }): AgentsRoutes {
  const now = opts.now ?? Date.now
  const file = join(opts.stateDir, 'agents.json')
  const mutex = makeMutex()

  const handleInner = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    // List all agents
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      const reg = loadRegistry(file)
      json(res, 200, { agents: reg.agents })
      return true
    }

    // Create a new agent
    if (req.method === 'POST' && url.pathname === '/api/agents') {
      let raw: unknown
      try {
        raw = await readJson(req)
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : 'invalid JSON' })
        return true
      }
      if (!isRecord(raw)) {
        json(res, 400, { error: 'invalid JSON' })
        return true
      }

      const name =
        typeof raw.name === 'string' && raw.name.trim()
          ? raw.name.trim().slice(0, 128)
          : 'Unnamed Agent'
      const colorRaw = parseColor(raw.color)
      if (raw.color !== undefined && colorRaw === undefined) {
        json(res, 400, { error: 'color must be a hex value' })
        return true
      }
      const color = colorRaw ?? ''
      const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 128) : ''
      const effortValue = typeof raw.effort === 'string' ? raw.effort : ''
      const effort = isEffortLevel(effortValue) ? effortValue : 'medium'
      const systemPrompt =
        typeof raw.systemPrompt === 'string'
          ? raw.systemPrompt.trim().slice(0, SYSTEM_PROMPT_MAX_CHARS)
          : ''
      const nodeBaseUrl =
        typeof raw.nodeBaseUrl === 'string' ? raw.nodeBaseUrl.trim().slice(0, 512) : ''

      if (!nodeBaseUrl) {
        json(res, 400, { error: 'nodeBaseUrl is required' })
        return true
      }
      if (!isHttpUrl(nodeBaseUrl)) {
        json(res, 400, { error: 'nodeBaseUrl must be an http(s) URL' })
        return true
      }

      const reg = loadRegistry(file)
      const agent: AgentPreset = {
        id: randomUUID(),
        name,
        color,
        model,
        effort,
        systemPrompt,
        nodeBaseUrl,
        createdAt: now(),
        updatedAt: now(),
      }
      reg.agents.push(agent)
      saveRegistry(file, reg)
      json(res, 201, { agent })
      return true
    }

    // Get single agent
    const idMatch = url.pathname.match(/^\/api\/agents\/([\w-]+)$/)
    if (req.method === 'GET' && idMatch) {
      const id = idMatch[1]
      const reg = loadRegistry(file)
      const maybeAgent = reg.agents.find((a) => a.id === id)
      if (!maybeAgent) {
        json(res, 404, { error: 'agent not found' })
        return true
      }
      json(res, 200, { agent: maybeAgent })
      return true
    }

    // Update agent
    if (req.method === 'PATCH' && idMatch) {
      const id = idMatch[1]
      let raw: unknown
      try {
        raw = await readJson(req)
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : 'invalid JSON' })
        return true
      }
      if (!isRecord(raw)) {
        json(res, 400, { error: 'invalid JSON' })
        return true
      }

      const reg = loadRegistry(file)
      const maybeAgent = reg.agents.find((a) => a.id === id)
      if (!maybeAgent) {
        json(res, 404, { error: 'agent not found' })
        return true
      }
      const agent = maybeAgent

      if (typeof raw.nodeBaseUrl === 'string') {
        const next = raw.nodeBaseUrl.trim()
        if (!next) {
          json(res, 400, { error: 'nodeBaseUrl is required' })
          return true
        }
        if (next !== agent.nodeBaseUrl) {
          json(res, 400, { error: NODE_IMMUTABLE })
          return true
        }
      }

      if (typeof raw.name === 'string' && raw.name.trim()) {
        agent.name = raw.name.trim().slice(0, 128)
      }
      if (raw.color !== undefined) {
        const color = parseColor(raw.color)
        if (color === undefined) {
          json(res, 400, { error: 'color must be a hex value' })
          return true
        }
        agent.color = color
      }
      if (typeof raw.model === 'string') {
        agent.model = raw.model.trim().slice(0, 128)
      }
      if (typeof raw.effort === 'string' && isEffortLevel(raw.effort)) {
        agent.effort = raw.effort
      }
      if (typeof raw.systemPrompt === 'string') {
        agent.systemPrompt = raw.systemPrompt.trim().slice(0, SYSTEM_PROMPT_MAX_CHARS)
      }
      agent.updatedAt = now()
      saveRegistry(file, reg)
      json(res, 200, { agent })
      return true
    }

    // Delete agent
    if (req.method === 'DELETE' && idMatch) {
      const id = idMatch[1]
      const reg = loadRegistry(file)
      const exists = reg.agents.some((a) => a.id === id)
      if (!exists) {
        json(res, 404, { error: 'agent not found' })
        return true
      }
      reg.agents = reg.agents.filter((a) => a.id !== id)
      saveRegistry(file, reg)
      json(res, 200, { ok: true })
      return true
    }

    json(res, 405, { error: 'method not allowed' })
    return true
  }

  return {
    async handle(req, res, url) {
      if (url.pathname !== '/api/agents' && !url.pathname.startsWith('/api/agents/')) return false
      return mutex(() => handleInner(req, res, url))
    },
  }
}
