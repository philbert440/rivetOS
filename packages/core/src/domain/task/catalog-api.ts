/**
 * /api/catalog — gateway route family (G4, Appendix F).
 *
 * The node's capability sheet for RivetHub settings and task creation:
 * agents (id/provider/model), registered task executors with their
 * capability matrices and slash-command manifests (listCommands, when the
 * executor supports it), tool names, skills, and — when the mesh registry is
 * available — where each mesh agent lives (RivetHub's node switcher + the
 * task API's affinity resolution both read this).
 *
 *   GET /api/catalog          the full sheet
 *   GET /api/catalog/agents   just agents (local + mesh locations)
 */

import type { ServerResponse } from 'node:http'
import type {
  CatalogAgent,
  CatalogAgentsResponse,
  CatalogCommand,
  CatalogExecutorEntry,
  CatalogSheet,
  GatewayRoute,
  HarnessExecutor,
  MeshNode,
  MeshRegistry,
  Skill,
  Tool,
} from '@rivetos/types'
import type { Router } from '../router.js'
import { ROSTER_READ_BOUND_MS, type PresetDelegationEngine } from '../preset-delegation.js'
import type { TaskExecutorRegistry } from './runner.js'
import { isHarnessExecutorTarget, isNotImplementedHarnessExecutor } from './harness-executors.js'
import { logger } from '../../logger.js'

const log = logger('CatalogApi')

/** Registry key prefix for harness-session entries (`kind:target`). */
const HARNESS_KEY_PREFIX = 'harness-session:'

export interface CatalogApiOptions {
  nodeName: string
  router: Router
  tools: () => Tool[]
  executors: TaskExecutorRegistry
  skills?: () => Skill[]
  meshRegistry?: MeshRegistry
  /** RivetHub presets appended as `kind: 'preset'` catalog agents. */
  presets?: PresetDelegationEngine
  /**
   * Bound for the fresh preset roster. Default {@link ROSTER_READ_BOUND_MS}.
   * Tests shorten it. A hung store falls back to `rosterEntries()` (last-known).
   */
  rosterFreshTimeoutMs?: number
}

const lastMeshNodes = new WeakMap<MeshRegistry, MeshNode[]>()
/** Generation of the latest getNodes() this registry started. An older read must not publish. */
const meshReadGeneration = new WeakMap<MeshRegistry, number>()

/**
 * Bound `getNodes`. Timeout or rejection returns the last snapshot this
 * registry published (empty until the first success). A late completion
 * publishes only when no newer read has started.
 */
function boundedMeshNodes(registry: MeshRegistry, timeoutMs: number): Promise<MeshNode[]> {
  const fallback = lastMeshNodes.get(registry) ?? []
  const gen = (meshReadGeneration.get(registry) ?? 0) + 1
  meshReadGeneration.set(registry, gen)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<MeshNode[]>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs)
    timer.unref()
  })
  const work = registry.getNodes().then(
    (nodes) => {
      if (meshReadGeneration.get(registry) === gen) lastMeshNodes.set(registry, nodes)
      return nodes
    },
    () => fallback,
  )
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function raceRoster<T>(work: Promise<T>, timeoutMs: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), timeoutMs)
    timer.unref()
  })
  return Promise.race([work.catch(() => fallback()), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

async function presetCatalogAgents(opts: CatalogApiOptions): Promise<CatalogAgent[]> {
  if (!opts.presets) return []
  const bound = opts.rosterFreshTimeoutMs ?? ROSTER_READ_BOUND_MS
  const presets = opts.presets
  const entries = await raceRoster(presets.rosterEntriesFresh({ timeoutMs: bound }), bound, () =>
    presets.rosterEntries(),
  )
  return entries.map((entry): CatalogAgent => ({
    kind: 'preset',
    id: entry.id,
    name: entry.name,
    node: entry.node,
    local: entry.local,
    ...(entry.harnessId ? { harnessId: entry.harnessId } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.directory ? { directory: entry.directory } : {}),
    ...(entry.implemented !== undefined ? { implemented: entry.implemented } : {}),
    ...(entry.gap ? { gap: entry.gap } : {}),
  }))
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Same agent sheet `/api/catalog/agents` serves — OpenAI `/v1/models` reuses this. */
export async function buildCatalogAgents(opts: CatalogApiOptions): Promise<CatalogAgent[]> {
  const local = opts.router.getAgents().map((a): CatalogAgent => ({
    id: a.id,
    provider: a.provider,
    model: a.model,
    node: opts.nodeName,
    local: true,
  }))
  const presets = await presetCatalogAgents(opts)
  if (!opts.meshRegistry) return [...local, ...presets]
  // Same bound as roster reads. A hung getNodes must not pin the catalog.
  const nodes = await boundedMeshNodes(
    opts.meshRegistry,
    opts.rosterFreshTimeoutMs ?? ROSTER_READ_BOUND_MS,
  )
  const remote = nodes
    .filter((n) => n.status === 'online' && n.name !== opts.nodeName)
    .flatMap((n) => {
      // Per-agent detail the node advertised in registration (#272); absent
      // on older peers, in which case remote entries stay id@node.
      const details = n.metadata?.agentDetails
      const detailFor = (agentId: string): { provider: string; model?: string } | undefined => {
        if (!details || typeof details !== 'object') return undefined
        const d = (details as Record<string, unknown>)[agentId]
        if (
          !d ||
          typeof d !== 'object' ||
          typeof (d as { provider?: unknown }).provider !== 'string'
        )
          return undefined
        const { provider, model } = d as { provider: string; model?: unknown }
        return typeof model === 'string' ? { provider, model } : { provider }
      }
      const agentIds = Array.isArray(n.agents) ? n.agents : []
      return agentIds.map((agentId): CatalogAgent => {
        const d = detailFor(agentId)
        return d
          ? { id: agentId, node: n.name, local: false, provider: d.provider, model: d.model }
          : { id: agentId, node: n.name, local: false }
      })
    })
  return [...local, ...remote, ...presets]
}

export function createCatalogApiRoute(opts: CatalogApiOptions): GatewayRoute {
  return {
    prefix: '/api/catalog',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sub = url.pathname.slice('/api/catalog'.length).replace(/^\//, '')

        const agents = await buildCatalogAgents(opts)
        if (sub === 'agents') return json(res, 200, { agents } satisfies CatalogAgentsResponse)
        if (sub !== '') return json(res, 404, { error: `no catalog section "${sub}"` })

        // Per-executor deadline: a hung listCommands() probe must degrade to
        // an empty manifest, never block the whole sheet (review follow-up).
        const COMMANDS_TIMEOUT_MS = 3_000
        // No cast: HarnessExecutor.listCommands items are structurally
        // CatalogCommand, so the wire contract is enforced end to end
        // (#295 review).
        const commandsFor = async (executor: HarnessExecutor): Promise<CatalogCommand[]> => {
          if (!executor.listCommands) return []
          return Promise.race([
            executor.listCommands().catch((): CatalogCommand[] => []),
            new Promise<CatalogCommand[]>((resolve) =>
              setTimeout(() => resolve([]), COMMANDS_TIMEOUT_MS).unref?.(),
            ),
          ])
        }
        const executors = await Promise.all(
          opts.executors.entries().map(async ({ key, executor }): Promise<CatalogExecutorEntry> => {
            const entry: CatalogExecutorEntry = {
              key,
              capabilities: executor.capabilities(),
              commands: await commandsFor(executor),
            }
            // harness-session entries carry their harness id and whether the
            // registration is a real harness or a registered rejection, so a
            // client can tell "we have kimi" from "we know about kimi".
            const target = key.startsWith(HARNESS_KEY_PREFIX)
              ? key.slice(HARNESS_KEY_PREFIX.length)
              : undefined
            if (target !== undefined && isHarnessExecutorTarget(target)) {
              entry.harnessId = target
              entry.implemented = !isNotImplementedHarnessExecutor(executor)
            }
            return entry
          }),
        )

        return json(res, 200, {
          node: opts.nodeName,
          agents,
          executors,
          tools: opts.tools().map((t) => t.name),
          skills: (opts.skills?.() ?? []).map((sk) => ({
            name: sk.name,
            description: sk.description,
          })),
        } satisfies CatalogSheet)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`catalog api error: ${msg}`)
        if (!res.headersSent) json(res, 500, { error: msg })
      }
    },
  }
}
