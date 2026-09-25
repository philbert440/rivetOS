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
 * table is ready, otherwise the per-node `agents.json` file. POST and PATCH
 * share one chain on both backends: POST holds the name key and, when that
 * name already exists, the preset's id key (the same key PATCH uses), plus
 * the directory key. The filesystem is not a place to delete things the
 * store has not accepted: POST creates the directory first and the
 * `rivet-shared` link only after `store.create` accepts the row, and a
 * rejected POST removes only an empty directory this call created that no
 * stored row owns. PATCH updates the row before it touches disk and unlinks
 * only when this patch flips `sharedLink` off without moving the directory.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, lstatSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  AGENT_SORT_ORDER_MAX,
  SYSTEM_PROMPT_MAX_CHARS,
  type AgentPreset,
  type HarnessId,
} from '@rivetos/types'
import {
  PresetConflictError,
  defaultDirectoryFor,
  directoryWarnings,
  ensureAgentDirectory,
  importLegacyAgentsJson,
  isRecord,
  nameKey,
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

/** `info` is directory create/link. `warn` is a non-fatal directory warning. Errors stay `error`. */
export type AgentRouteLog = (msg: string, level?: 'info' | 'warn' | 'error') => void

const readJson = (req: IncomingMessage, limit = 64 * 1024): Promise<unknown> =>
  new Promise((resolveBody, reject) => {
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
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })

const json = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * No symlink is there. `ENOTDIR` is a parent that is a file (the mkdir-failure
 * test points `directoryRoot` at one) — that must stay a 500 from
 * `ensureAgentDirectory`, not an escaped throw from the pre-check.
 */
function isAbsentPath(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  return err.code === 'ENOENT' || err.code === 'ENOTDIR'
}

function hasDotDot(path: string): boolean {
  return path.split(/[/\\]/).includes('..')
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
 * every preset on this den's node. Idempotent and not limited to rows this
 * call inserted: an import that crashed after INSERT skips those ids on the
 * next boot, but `list({node})` still returns them so their directories get
 * created. Slices 3 and 5 also ensure the directory on use. Directory
 * failures are logged; the row stays. The caller fire-and-forgets this — a
 * down database must not delay boot.
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
  let hosted: AgentPreset[]
  try {
    hosted = await opts.store.list({ node: opts.nodeName })
  } catch (err) {
    opts.log?.(`could not list presets to materialize: ${errorMessage(err)}`)
    hosted = (result.rows ?? []).filter((row) => row.node === opts.nodeName)
  }
  for (const row of hosted) {
    if (row.node !== opts.nodeName || !row.directory) continue
    try {
      const ensured = ensureAgentDirectory(
        { directory: row.directory, sharedLink: row.sharedLink },
        {
          ...(opts.sharedDir ? { sharedDir: opts.sharedDir } : {}),
          // "created" / "linked" are info, not errors. Failures use opts.log.
          log: (msg) => console.log(`[den-server] ${msg}`),
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
  /** `level` defaults to `error` for a pre-existing `(msg) => void` logger. */
  log?: AgentRouteLog
}): AgentsRoutes {
  const store = opts.store
  const nodeName = opts.nodeName
  const directoryRoot = opts.directoryRoot
  const sharedDir = opts.sharedDir
  const homeDir = opts.homeDir ?? homedir
  const now = opts.now ?? Date.now
  const log: AgentRouteLog =
    opts.log ??
    ((msg, level = 'error') => {
      const line = `[den-server] ${msg}`
      if (level === 'info') console.log(line)
      else if (level === 'warn') console.warn(line)
      else console.error(line)
    })
  const info = (msg: string): void => {
    log(msg, 'info')
  }
  const warn = (msg: string): void => {
    log(msg, 'warn')
  }
  const error = (msg: string): void => {
    log(msg, 'error')
  }

  const unavailable = (res: ServerResponse, err: unknown): void => {
    error(`agent registry unavailable: ${errorMessage(err)}`)
    json(res, 503, { error: 'agent registry unavailable' })
  }

  const chains = new Map<string, Promise<void>>()
  const withChain = (key: string, fn: () => Promise<void>): Promise<void> => {
    const prev = chains.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    chains.set(key, settled)
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key)
    })
    return run
  }

  const expandHome = (raw: string): string => {
    if (!raw.startsWith('~/')) return raw
    return join(homeDir(), raw.slice(2))
  }

  /** Empty → the default directory. `..` (absolute or after `~/`) is rejected. */
  const resolveDirectory = (raw: unknown, name: string): string | undefined => {
    if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      return validateDirectory(defaultDirectoryFor(directoryRoot, name))
    }
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    if (hasDotDot(trimmed)) return undefined
    const expanded = expandHome(trimmed)
    if (hasDotDot(expanded)) return undefined
    return validateDirectory(expanded)
  }

  const linkPath = (directory: string): string => join(directory, LINK_NAME)

  /**
   * Unlink `rivet-shared` only when the link's real parent is this preset's
   * real directory and the target, resolved against that real parent, is
   * `sharedDir`. Lexical `resolve` is wrong for a symlinked parent: `../shared`
   * from `/tmp/alias` → `/tmp/other/agent` is `/tmp/other/shared`, not
   * `/tmp/shared`. A realpath failure leaves the link (do not unlink).
   */
  const removeSharedLink = (directory: string): void => {
    if (!sharedDir) return
    const link = linkPath(directory)
    let target: string
    try {
      if (!lstatSync(link).isSymbolicLink()) return
      target = readlinkSync(link)
    } catch (err) {
      if (isAbsentPath(err)) return
      throw err
    }
    let linkParentReal: string
    let presetReal: string
    let targetReal: string
    let sharedReal: string
    try {
      linkParentReal = realpathSync.native(dirname(link))
      presetReal = realpathSync.native(directory)
      targetReal = realpathSync.native(resolve(linkParentReal, target))
      sharedReal = realpathSync.native(sharedDir)
    } catch {
      return
    }
    if (linkParentReal !== presetReal) return
    if (targetReal !== sharedReal) return
    unlinkSync(link)
  }

  /**
   * Drop an empty directory this call created. Never unlinks. A row that now
   * owns `directory` (a concurrent create accepted it) keeps the directory.
   */
  const undoCreated = async (directory: string, createdDir: boolean): Promise<void> => {
    if (!createdDir) return
    try {
      const rows = await store.list()
      if (rows.some((row) => row.directory === directory)) return
    } catch (err) {
      error(`could not check agent directory ownership: ${errorMessage(err)}`)
      return
    }
    try {
      rmdirSync(directory)
    } catch {
      // Not empty, or already gone. A directory this call did not leave empty stays.
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

  const createPreset = async (raw: Record<string, unknown>, res: ServerResponse): Promise<void> => {
    const name =
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim().slice(0, 128)
        : 'Unnamed Agent'
    const colorRaw = parseColor(raw.color)
    if (raw.color !== undefined && colorRaw === undefined) {
      json(res, 400, { error: 'color must be a hex value' })
      return
    }
    const color = colorRaw ?? ''
    const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 128) : ''
    const effortParsed = parseEffort(raw.effort)
    if (raw.effort !== undefined && effortParsed === undefined) {
      json(res, 400, { error: 'effort must be a 0-64 token' })
      return
    }
    const effort = effortParsed ?? 'medium'
    const hid = parseHarnessId(raw.harnessId)
    if (hid === 'bad') {
      json(res, 400, { error: 'harnessId must be a known harness' })
      return
    }
    const harnessId: HarnessId | undefined = hid
    const systemPrompt =
      typeof raw.systemPrompt === 'string'
        ? raw.systemPrompt.trim().slice(0, SYSTEM_PROMPT_MAX_CHARS)
        : ''
    // Create stores a trimmed client `nodeBaseUrl` (at most 512 characters)
    // when one is sent, and never requires it. Hubs that send none store ''.
    // Update never patches it. List and GET still echo a URL a legacy file
    // row already has. Placement is `node` + `directory`.
    const nodeBaseUrl =
      typeof raw.nodeBaseUrl === 'string' ? raw.nodeBaseUrl.trim().slice(0, 512) : ''
    if (typeof raw.node === 'string' && raw.node.trim() && raw.node.trim() !== nodeName) {
      json(res, 400, { error: `agent must be created on its hosting node (${nodeName})` })
      return
    }
    const sharedLink = typeof raw.sharedLink === 'boolean' ? raw.sharedLink : true
    const directory = resolveDirectory(raw.directory, name)
    if (!directory) {
      json(res, 400, { error: DIRECTORY_ABS })
      return
    }

    // POST never unlinks. The directory is created first; the link waits until
    // `store.create` accepts the row, so a 409 cannot remove a link a
    // concurrent PATCH just enabled. `sharedLink: false` never creates one.
    // A directory this call created is removed only when the store rejects
    // the row, the directory is still empty, and no stored row owns it.
    const dirExisted = existsSync(directory)
    let createdDir: boolean
    try {
      const ensured = ensureAgentDirectory(
        { directory, sharedLink: false },
        { ...(sharedDir ? { sharedDir } : {}), log: info },
      )
      createdDir = ensured.created && !dirExisted
      if (ensured.reason) warn(ensured.reason)
      for (const warning of directoryWarnings(directory, sharedDir)) warn(warning)
    } catch (err) {
      await undoCreated(directory, !dirExisted && existsSync(directory))
      json(res, 500, { error: `could not create agent directory: ${errorMessage(err)}` })
      return
    }

    let agent: AgentPreset
    try {
      agent = await store.create({
        name,
        color,
        model,
        effort,
        systemPrompt,
        node: nodeName,
        directory,
        sharedLink,
        nodeBaseUrl,
        ...(harnessId ? { harnessId } : {}),
        createdAt: now(),
      })
    } catch (err) {
      await undoCreated(directory, createdDir)
      if (err instanceof PresetConflictError) {
        json(res, 409, { error: `an agent named "${name}" already exists` })
        return
      }
      unavailable(res, err)
      return
    }

    const storedDirectory = agent.directory ?? directory
    if (agent.sharedLink !== false) {
      try {
        const linked = ensureAgentDirectory(
          { directory: storedDirectory, sharedLink: true },
          { ...(sharedDir ? { sharedDir } : {}), log: info },
        )
        if (linked.reason) warn(linked.reason)
      } catch (err) {
        json(res, 500, { error: `could not create agent directory: ${errorMessage(err)}` })
        return
      }
    }
    json(res, 201, { agent })
  }

  const patchPreset = async (
    id: string,
    raw: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> => {
    let existing: AgentPreset | undefined
    try {
      existing = await store.get(id)
    } catch (err) {
      unavailable(res, err)
      return
    }
    if (!existing) {
      json(res, 404, { error: 'agent not found' })
      return
    }

    // A legacy file row has no node. Treat that as this den so a client
    // re-sending the local name is not "immutable", and so the preset is not
    // foreign.
    const storedNode = existing.node?.trim() || nodeName
    if (raw.node !== undefined) {
      const next = typeof raw.node === 'string' ? raw.node.trim() : undefined
      if (next !== storedNode) {
        json(res, 400, { error: NODE_IMMUTABLE })
        return
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
        return
      }
      patch.color = color
    }
    if (typeof raw.model === 'string') patch.model = raw.model.trim().slice(0, 128)
    if (raw.effort !== undefined) {
      const effort = parseEffort(raw.effort)
      if (effort === undefined) {
        json(res, 400, { error: 'effort must be a 0-64 token' })
        return
      }
      patch.effort = effort
    }
    if (raw.harnessId !== undefined) {
      const hid = parseHarnessId(raw.harnessId)
      if (hid === 'bad') {
        json(res, 400, { error: 'harnessId must be a known harness' })
        return
      }
      patch.harnessId = hid ?? null
    }
    if (typeof raw.systemPrompt === 'string') {
      patch.systemPrompt = raw.systemPrompt.trim().slice(0, SYSTEM_PROMPT_MAX_CHARS)
    }
    if (raw.sortOrder !== undefined) {
      if (
        raw.sortOrder !== null &&
        !(
          typeof raw.sortOrder === 'number' &&
          Number.isInteger(raw.sortOrder) &&
          raw.sortOrder >= 0 &&
          raw.sortOrder <= AGENT_SORT_ORDER_MAX
        )
      ) {
        json(res, 400, {
          error: `sortOrder must be an integer 0-${String(AGENT_SORT_ORDER_MAX)} or null`,
        })
        return
      }
      patch.sortOrder = raw.sortOrder
    }

    // An unchanged directory or sharedLink is not a placement request. A form
    // that round-trips every field must not 409 a foreign preset. Compare the
    // sent text before `~/` expansion so a real change still 409s without
    // calling homeDir.
    const storedDirectory = existing.directory ?? ''
    const storedSharedLink = existing.sharedLink !== false
    const directoryChanged =
      raw.directory !== undefined &&
      (typeof raw.directory !== 'string' || raw.directory.trim() !== storedDirectory)
    const sharedLinkChanged =
      typeof raw.sharedLink === 'boolean' && raw.sharedLink !== storedSharedLink
    const placementChange = directoryChanged || sharedLinkChanged
    const hostedOn = typeof existing.node === 'string' ? existing.node.trim() : ''
    if (placementChange && hostedOn !== '' && hostedOn !== nodeName) {
      json(res, 409, { error: `agent "${existing.name}" is hosted on ${hostedOn}` })
      return
    }

    let materializeDirectory = false
    if (placementChange) {
      let nextDirectory = existing.directory
      const nextSharedLink = existing.sharedLink !== false
      if (raw.directory !== undefined) {
        const directory = resolveDirectory(raw.directory, name)
        if (!directory) {
          json(res, 400, { error: DIRECTORY_ABS })
          return
        }
        nextDirectory = directory
        if (directory !== existing.directory) patch.directory = directory
      }
      if (typeof raw.sharedLink === 'boolean' && raw.sharedLink !== nextSharedLink) {
        patch.sharedLink = raw.sharedLink
      }
      // Legacy rows have no directory. Default it (and persist it) instead of
      // 400 when the client only asked to change the link.
      if (!nextDirectory) {
        const fallback = resolveDirectory(undefined, name)
        if (!fallback) {
          json(res, 400, { error: DIRECTORY_ABS })
          return
        }
        patch.directory = fallback
      }
      materializeDirectory = true
    }

    let agent: AgentPreset | undefined
    try {
      agent = await store.update(id, patch)
    } catch (err) {
      if (err instanceof PresetConflictError) {
        json(res, 409, { error: `an agent named "${name}" already exists` })
        return
      }
      unavailable(res, err)
      return
    }
    if (!agent) {
      json(res, 404, { error: 'agent not found' })
      return
    }

    // Disk follows the stored row. A 409/503/400 above never reached here, so
    // a rejected rename leaves the existing link alone.
    if (materializeDirectory) {
      const directory = agent.directory
      if (!directory) {
        json(res, 500, { error: `could not create agent directory: ${DIRECTORY_ABS}` })
        return
      }
      try {
        // Unlink only a flip to false in this same directory. A move, or a
        // repeated `sharedLink: false`, must not delete a link that belongs
        // to another preset (including `$HOME/rivet-shared`).
        if (patch.sharedLink === false && directory === existing.directory) {
          removeSharedLink(directory)
        }
        const ensured = ensureAgentDirectory(
          { directory, sharedLink: agent.sharedLink !== false },
          { ...(sharedDir ? { sharedDir } : {}), log: info },
        )
        if (ensured.reason) warn(ensured.reason)
        for (const warning of directoryWarnings(directory, sharedDir)) warn(warning)
      } catch (err) {
        json(res, 500, { error: `could not create agent directory: ${errorMessage(err)}` })
        return
      }
    }
    json(res, 200, { agent })
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
      const directory = resolveDirectory(raw.directory, name)
      try {
        // Name key, then the existing preset's id (PATCH's key), then the
        // directory. Same order on every POST so two creates cannot deadlock.
        await withChain(`post:${nameKey(name)}`, async () => {
          let existingId: string | undefined
          try {
            const existing = await store.findByHandle(name)
            if (existing && nameKey(existing.name) === nameKey(name)) existingId = existing.id
          } catch (err) {
            unavailable(res, err)
            return
          }
          const write = (): Promise<void> => {
            if (!directory) return createPreset(raw, res)
            return withChain(`dir:${directory}`, () => createPreset(raw, res))
          }
          if (existingId) await withChain(existingId, write)
          else await write()
        })
      } catch (err) {
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
      try {
        await withChain(id, () => patchPreset(id, raw, res))
      } catch (err) {
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
