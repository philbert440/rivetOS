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
  CatalogSheet,
  GatewayRoute,
  MeshRegistry,
  Skill,
  Tool,
} from '@rivetos/types'
import type { Router } from '../router.js'
import type { TaskExecutorRegistry } from './runner.js'
import { logger } from '../../logger.js'

const log = logger('CatalogApi')

export interface CatalogApiOptions {
  nodeName: string
  router: Router
  tools: () => Tool[]
  executors: TaskExecutorRegistry
  skills?: () => Skill[]
  meshRegistry?: MeshRegistry
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function buildAgents(opts: CatalogApiOptions): Promise<CatalogAgent[]> {
  const local = opts.router.getAgents().map((a): CatalogAgent => ({
    id: a.id,
    provider: a.provider,
    model: a.model,
    node: opts.nodeName,
    local: true,
  }))
  if (!opts.meshRegistry) return local
  const nodes = await opts.meshRegistry.getNodes()
  const remote = nodes
    .filter((n) => n.status === 'online' && n.name !== opts.nodeName)
    .flatMap((n) =>
      n.agents.map((agentId): CatalogAgent => ({
        id: agentId,
        node: n.name,
        local: false,
      })),
    )
  return [...local, ...remote]
}

export function createCatalogApiRoute(opts: CatalogApiOptions): GatewayRoute {
  return {
    prefix: '/api/catalog',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sub = url.pathname.slice('/api/catalog'.length).replace(/^\//, '')

        const agents = await buildAgents(opts)
        if (sub === 'agents') return json(res, 200, { agents } satisfies CatalogAgentsResponse)
        if (sub !== '') return json(res, 404, { error: `no catalog section "${sub}"` })

        // Per-executor deadline: a hung listCommands() probe must degrade to
        // an empty manifest, never block the whole sheet (review follow-up).
        const COMMANDS_TIMEOUT_MS = 3_000
        const commandsFor = async (executor: {
          listCommands?: () => Promise<CatalogCommand[]>
        }): Promise<CatalogCommand[]> => {
          if (!executor.listCommands) return []
          return Promise.race([
            executor.listCommands().catch((): CatalogCommand[] => []),
            new Promise<CatalogCommand[]>((resolve) =>
              setTimeout(() => resolve([]), COMMANDS_TIMEOUT_MS).unref?.(),
            ),
          ])
        }
        const executors = await Promise.all(
          opts.executors.entries().map(async ({ key, executor }) => ({
            key,
            capabilities: executor.capabilities(),
            commands: await commandsFor(
              executor as { listCommands?: () => Promise<CatalogCommand[]> },
            ),
          })),
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
