/**
 * Agent presets (/api/agents/*) — named agent configurations that can be
 * applied to sessions. Each preset holds model, effort level, optional
 * system prompt, optional color, the mesh node that hosts it, and a working
 * directory.
 *
 *   GET    /api/agents           list presets (`?node=` filters)
 *   POST   /api/agents           create on this den's node
 *   GET    /api/agents/:id       get one
 *   PATCH  /api/agents/:id       update (`node` is immutable)
 *   DELETE /api/agents/:id       delete the row; the directory stays
 *
 * The store is chosen by server.ts: Postgres (`ros_agent_presets`) when the
 * table is ready, otherwise the per-node `agents.json` file. Writes are one
 * store call. The file store already serializes its own read-modify-write,
 * and Postgres is one statement, so this router does not add a second mutex.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstatSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_PROMPT_MAX_CHARS, type AgentPreset, type HarnessId } from '@rivetos/types'
import {
  PresetConflictError,
  defaultDirectoryFor,
  directoryWarnings,
  ensureAgentDirectory,
  importLegacyAgentsJson,
  isRecord,
  parseColor,
  parseEffort,
  parseHarnessId,
  validateDirectory,
  type AgentPresetPatch,
  type AgentPresetStore,
  type ImportLegacyAgentsResult,
} from '@rivetos/agent-registry'

const NODE_IMMUTABLE = 'node is immutable; recreate the agent'
const DIRECTORY_ABS = 'directory must be an absolute path'
const LINK_NAME = 'rivet-shared'

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

export interface AgentsRoutes {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
}

export interface ImportAndMaterializeLegacyArgs {
  file: string
  /** Primary store. Never the fallback wrapper — importing the live file would rename it. */
  store: AgentPresetStore
  nodeName: string
  directoryRoot: string
  sharedDir?: string
  log?: (msg: string) => void
}

/**
 * One-shot legacy import plus a directory (and `rivet-shared` symlink) for
 * each row this call wrote. Directory failures are logged; the row stays.
 * The caller fire-and-forgets this — a down database must not delay boot.
 */
export async function importAndMaterializeLegacyAgents(
  opts: ImportAndMaterializeLegacyArgs,
): Promise<ImportLegacyAgentsResult> {
  const result = await importLegacyAgentsJson({
    file: opts.file,
    store: opts.store,
    node: opts.nodeName,
    directoryRoot: opts.directoryRoot,
    ...(opts.log ? { log: opts.log } : {}),
  })
  for (const row of result.rows ?? []) {
    if (!row.directory) continue
    try {
      const ensured = ensureAgentDirectory(
        { directory: row.directory, sharedLink: row.sharedLink },
        {
          ...(opts.sharedDir ? { sharedDir: opts.sharedDir } : {}),
          ...(opts.log ? { log: opts.log } : {}),
        },
      )
      if (ensured.reason) console.warn(`[den-server] ${ensured.reason}`)
      for (const warning of directoryWarnings(row.directory, opts.sharedDir)) {
        console.warn(`[den-server] ${warning}`)
      }
    } catch (err) {
      opts.log?.(`could not create agent directory: ${errorMessage(err)}`)
    }
  }
  return result
}

export function createAgentsRoutes(opts: {
  store: AgentPresetStore
  nodeName: string
  /** Default parent for a preset that does not name a directory. */
  directoryRoot: string
  /** Shared directory the `rivet-shared` symlink targets, when configured. */
  sharedDir?: string
  /** For `~/` expansion. Default `os.homedir`. */
  homeDir?: () => string
  now?: () => number
  log?: (msg: string) => void
}): AgentsRoutes {
  const store = opts.store
  const nodeName = opts.nodeName
  const directoryRoot = opts.directoryRoot
  const sharedDir = opts.sharedDir
  const homeDir = opts.homeDir ?? homedir
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((msg: string) => console.error(`[den-server] ${msg}`))

  const warn = (msg: string): void => {
    console.warn(`[den-server] ${msg}`)
  }

  const unavailable = (res: ServerResponse, err: unknown): void => {
    log(`agent registry unavailable: ${errorMessage(err)}`)
    json(res, 503, { error: 'agent registry unavailable' })
  }

  const expandHome = (raw: string): string => {
    if (!raw.startsWith('~/')) return raw
    return join(homeDir(), raw.slice(2))
  }

  /** Empty → the default directory. Anything else must validate. */
  const resolveDirectory = (raw: unknown, name: string): string | undefined => {
    if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      return validateDirectory(defaultDirectoryFor(directoryRoot, name))
    }
    if (typeof raw !== 'string') return undefined
    return validateDirectory(expandHome(raw.trim()))
  }

  const materialize = (
    directory: string,
    sharedLink: boolean,
  ): { ok: true } | { ok: false; error: string } => {
    try {
      if (!sharedLink) removeSharedSymlink(directory)
      const ensured = ensureAgentDirectory(
        { directory, sharedLink },
        { ...(sharedDir ? { sharedDir } : {}), log },
      )
      if (ensured.reason) warn(ensured.reason)
      for (const warning of directoryWarnings(directory, sharedDir)) warn(warning)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `could not create agent directory: ${errorMessage(err)}` }
    }
  }

  const readBody = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Record<string, unknown> | undefined> => {
    let raw: unknown
    try {
      raw = await readJson(req)
    } catch (err) {
      json(res, 400, { error: errorMessage(err) })
      return undefined
    }
    if (!isRecord(raw)) {
      json(res, 400, { error: 'invalid JSON' })
      return undefined
    }
    return raw
  }

  const handleInner = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      const nodeFilter = url.searchParams.get('node')?.trim()
      try {
        const agents = await store.list(nodeFilter ? { node: nodeFilter } : undefined)
        json(res, 200, {
          agents,
          node: nodeName,
          directoryRoot,
          ...(sharedDir !== undefined ? { sharedDir } : {}),
          backend: store.backend,
        })
      } catch (err) {
        unavailable(res, err)
      }
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/agents') {
      const raw = await readBody(req, res)
      if (!raw) return true

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
      const effortParsed = parseEffort(raw.effort)
      if (raw.effort !== undefined && effortParsed === undefined) {
        json(res, 400, { error: 'effort must be a 0-64 token' })
        return true
      }
      const effort = effortParsed ?? 'medium'
      const hid = parseHarnessId(raw.harnessId)
      if (hid === 'bad') {
        json(res, 400, { error: 'harnessId must be a known harness' })
        return true
      }
      const harnessId: HarnessId | undefined = hid
      const systemPrompt =
        typeof raw.systemPrompt === 'string'
          ? raw.systemPrompt.trim().slice(0, SYSTEM_PROMPT_MAX_CHARS)
          : ''
      const nodeBaseUrl =
        typeof raw.nodeBaseUrl === 'string' ? raw.nodeBaseUrl.trim().slice(0, 512) : ''
      if (typeof raw.node === 'string' && raw.node.trim() && raw.node.trim() !== nodeName) {
        json(res, 400, { error: `agent must be created on its hosting node (${nodeName})` })
        return true
      }
      const sharedLink = typeof raw.sharedLink === 'boolean' ? raw.sharedLink : true
      const directory = resolveDirectory(raw.directory, name)
      if (!directory) {
        json(res, 400, { error: DIRECTORY_ABS })
        return true
      }
      const made = materialize(directory, sharedLink)
      if (!made.ok) {
        json(res, 500, { error: made.error })
        return true
      }

      try {
        const agent = await store.create({
          name,
          color,
          model,
          effort,
          systemPrompt,
          node: nodeName,
          directory,
          sharedLink,
          // Still accepted from pre-registry clients; the field is deprecated.
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          nodeBaseUrl,
          ...(harnessId ? { harnessId } : {}),
          createdAt: now(),
        })
        json(res, 201, { agent })
      } catch (err) {
        if (err instanceof PresetConflictError) {
          json(res, 409, { error: `an agent named "${name}" already exists` })
          return true
        }
        unavailable(res, err)
      }
      return true
    }

    const idMatch = url.pathname.match(/^\/api\/agents\/([\w-]+)$/)
    if (req.method === 'GET' && idMatch) {
      const id = idMatch[1]
      try {
        const agent = await store.get(id)
        if (!agent) {
          json(res, 404, { error: 'agent not found' })
          return true
        }
        json(res, 200, { agent })
      } catch (err) {
        unavailable(res, err)
      }
      return true
    }

    if (req.method === 'PATCH' && idMatch) {
      const id = idMatch[1]
      const raw = await readBody(req, res)
      if (!raw) return true

      let existing: AgentPreset | undefined
      try {
        existing = await store.get(id)
      } catch (err) {
        unavailable(res, err)
        return true
      }
      if (!existing) {
        json(res, 404, { error: 'agent not found' })
        return true
      }

      if (raw.node !== undefined) {
        const next = typeof raw.node === 'string' ? raw.node.trim() : undefined
        if (next !== existing.node) {
          json(res, 400, { error: NODE_IMMUTABLE })
          return true
        }
      }

      if (typeof raw.nodeBaseUrl === 'string') {
        const next = raw.nodeBaseUrl.trim().slice(0, 512)
        if (next) {
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          const storedUrl = existing.nodeBaseUrl
          if (storedUrl.trim() && next !== storedUrl) {
            json(res, 400, { error: NODE_IMMUTABLE })
            return true
          }
        }
      }

      const patch: AgentPresetPatch = {}
      let name = existing.name
      if (typeof raw.name === 'string' && raw.name.trim()) {
        name = raw.name.trim().slice(0, 128)
        patch.name = name
      }
      if (raw.color !== undefined) {
        const color = parseColor(raw.color)
        if (color === undefined) {
          json(res, 400, { error: 'color must be a hex value' })
          return true
        }
        patch.color = color
      }
      if (typeof raw.model === 'string') patch.model = raw.model.trim().slice(0, 128)
      if (raw.effort !== undefined) {
        const effort = parseEffort(raw.effort)
        if (effort === undefined) {
          json(res, 400, { error: 'effort must be a 0-64 token' })
          return true
        }
        patch.effort = effort
      }
      if (raw.harnessId !== undefined) {
        const hid = parseHarnessId(raw.harnessId)
        if (hid === 'bad') {
          json(res, 400, { error: 'harnessId must be a known harness' })
          return true
        }
        patch.harnessId = hid ?? null
      }
      if (typeof raw.systemPrompt === 'string') {
        patch.systemPrompt = raw.systemPrompt.trim().slice(0, SYSTEM_PROMPT_MAX_CHARS)
      }
      if (typeof raw.nodeBaseUrl === 'string') {
        const next = raw.nodeBaseUrl.trim().slice(0, 512)
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        const storedUrl = existing.nodeBaseUrl
        if (next && !storedUrl.trim()) patch.nodeBaseUrl = next
      }

      let nextDirectory = existing.directory
      let nextSharedLink = existing.sharedLink !== false
      let materializeDirectory = false
      if (raw.directory !== undefined) {
        const directory = resolveDirectory(raw.directory, name)
        if (!directory) {
          json(res, 400, { error: DIRECTORY_ABS })
          return true
        }
        nextDirectory = directory
        materializeDirectory = true
        if (directory !== existing.directory) patch.directory = directory
      }
      if (typeof raw.sharedLink === 'boolean' && raw.sharedLink !== nextSharedLink) {
        nextSharedLink = raw.sharedLink
        patch.sharedLink = raw.sharedLink
        materializeDirectory = true
      }
      if (materializeDirectory) {
        if (!nextDirectory) {
          json(res, 400, { error: DIRECTORY_ABS })
          return true
        }
        const made = materialize(nextDirectory, nextSharedLink)
        if (!made.ok) {
          json(res, 500, { error: made.error })
          return true
        }
      }

      try {
        const agent = await store.update(id, patch)
        if (!agent) {
          json(res, 404, { error: 'agent not found' })
          return true
        }
        json(res, 200, { agent })
      } catch (err) {
        if (err instanceof PresetConflictError) {
          json(res, 409, { error: `an agent named "${name}" already exists` })
          return true
        }
        unavailable(res, err)
      }
      return true
    }

    if (req.method === 'DELETE' && idMatch) {
      const id = idMatch[1]
      try {
        const ok = await store.delete(id)
        if (!ok) {
          json(res, 404, { error: 'agent not found' })
          return true
        }
        json(res, 200, { ok: true })
      } catch (err) {
        unavailable(res, err)
      }
      return true
    }

    json(res, 405, { error: 'method not allowed' })
    return true
  }

  return {
    async handle(req, res, url) {
      if (url.pathname !== '/api/agents' && !url.pathname.startsWith('/api/agents/')) return false
      return handleInner(req, res, url)
    },
  }
}

/** Drop a `rivet-shared` symlink. A real file or directory at that path stays. */
function removeSharedSymlink(directory: string): void {
  const link = join(directory, LINK_NAME)
  try {
    if (!lstatSync(link).isSymbolicLink()) return
  } catch (err) {
    if (isEnoent(err)) return
    throw err
  }
  unlinkSync(link)
}
