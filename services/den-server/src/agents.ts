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
 * mesh-devices but without the cross-node locking complexity.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentPreset } from '@rivetos/types'

// ---------------------------------------------------------------------------
// storage

interface Registry {
  agents: AgentPreset[]
}

function loadRegistry(file: string): Registry {
  if (!existsSync(file)) return { agents: [] }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Registry>
    return { agents: raw.agents ?? [] }
  } catch {
    return { agents: [] }
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

export function createAgentsRoutes(opts: {
  stateDir: string
  now?: () => number
}): AgentsRoutes {
  const now = opts.now ?? Date.now
  const file = join(opts.stateDir, 'agents.json')

  return {
    async handle(req, res, url) {
      if (url.pathname !== '/api/agents' && !url.pathname.startsWith('/api/agents/')) return false

      // List all agents
      if (req.method === 'GET' && url.pathname === '/api/agents') {
        const reg = loadRegistry(file)
        json(res, 200, { agents: reg.agents })
        return true
      }

      // Create a new agent
      if (req.method === 'POST' && url.pathname === '/api/agents') {
        let body: {
          name?: unknown
          color?: unknown
          model?: unknown
          effort?: unknown
          systemPrompt?: unknown
          nodeBaseUrl?: unknown
        }
        try {
          body = (await readJson(req)) as typeof body
        } catch (e) {
          json(res, 400, { error: (e as Error).message })
          return true
        }

        const name =
          typeof body.name === 'string' && body.name.trim()
            ? body.name.trim().slice(0, 128)
            : 'Unnamed Agent'
        const color = typeof body.color === 'string' ? body.color.trim().slice(0, 16) : ''
        const model = typeof body.model === 'string' ? body.model.trim().slice(0, 128) : ''
        const effort =
          typeof body.effort === 'string' &&
          ['off', 'low', 'medium', 'high', 'xhigh'].includes(body.effort)
            ? (body.effort as AgentPreset['effort'])
            : 'medium'
        const systemPrompt =
          typeof body.systemPrompt === 'string' ? body.systemPrompt.slice(0, 16384) : ''
        const nodeBaseUrl =
          typeof body.nodeBaseUrl === 'string' ? body.nodeBaseUrl.trim().slice(0, 512) : ''

        if (!nodeBaseUrl) {
          json(res, 400, { error: 'nodeBaseUrl is required' })
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
        const agent = reg.agents.find((a) => a.id === id)
        if (!agent) {
          json(res, 404, { error: 'agent not found' })
          return true
        }
        json(res, 200, { agent })
        return true
      }

      // Update agent
      if (req.method === 'PATCH' && idMatch) {
        const id = idMatch[1]
        let body: {
          name?: unknown
          color?: unknown
          model?: unknown
          effort?: unknown
          systemPrompt?: unknown
          nodeBaseUrl?: unknown
        }
        try {
          body = (await readJson(req)) as typeof body
        } catch (e) {
          json(res, 400, { error: (e as Error).message })
          return true
        }

        const reg = loadRegistry(file)
        const agent = reg.agents.find((a) => a.id === id)
        if (!agent) {
          json(res, 404, { error: 'agent not found' })
          return true
        }

        if (typeof body.name === 'string' && body.name.trim()) {
          agent.name = body.name.trim().slice(0, 128)
        }
        if (typeof body.color === 'string') {
          agent.color = body.color.trim().slice(0, 16)
        }
        if (typeof body.model === 'string') {
          agent.model = body.model.trim().slice(0, 128)
        }
        if (
          typeof body.effort === 'string' &&
          ['off', 'low', 'medium', 'high', 'xhigh'].includes(body.effort)
        ) {
          agent.effort = body.effort as AgentPreset['effort']
        }
        if (typeof body.systemPrompt === 'string') {
          agent.systemPrompt = body.systemPrompt.slice(0, 16384)
        }
        if (typeof body.nodeBaseUrl === 'string') {
          agent.nodeBaseUrl = body.nodeBaseUrl.trim().slice(0, 512)
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
    },
  }
}
