/**
 * SQLite task engine, end to end over the den transport.
 *
 * Boot stand-in: file preset + SqliteTaskStore + polling runner + the real
 * task and catalog routes. delegate_task / list_agents go through createDenTools
 * (POST /api/tasks, GET /api/tasks/:id/wait, GET /api/catalog/agents). No Postgres.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileAgentPresetStore, createCachedPresetResolver } from '@rivetos/agent-registry'
import {
  PresetDelegationEngine,
  SqliteTaskStore,
  createCatalogApiRoute,
  createExecutorRegistry,
  createPollingTaskRunner,
  createTaskApiRoute,
  createTaskCompletionWaiter,
  createTaskHandler,
  type PollingTaskRunner,
  type Router,
  type TaskExecutorRegistry,
} from '@rivetos/core'
import { RivetGateway } from '@rivetos/gateway-client'
import type {
  GatewayRoute,
  HarnessExecutor,
  TaskEvent,
  TaskResult,
  TaskUsage,
} from '@rivetos/types'
import { createDenTools, type DenToolsHandle } from './den-tools.js'

const NODE = 'laptop'
const MODEL = 'preset-model'
const ZERO: TaskUsage = {
  inputTokens: 1,
  outputTokens: 2,
  totalTokens: 3,
  turns: 1,
  wallClockMs: 1,
}

const okResult: TaskResult = {
  verdict: 'completed',
  summary: 'DELEGATED-OK',
  output: 'DELEGATED-OK',
  artifacts: [],
  usage: ZERO,
}

function capabilities(): ReturnType<HarnessExecutor['capabilities']> {
  return {
    steerable: false,
    multiTurn: false,
    structuredStream: false,
    usageInResult: true,
    sessionIdCapture: false,
    slashCommands: false,
    effortSelection: false,
    mcpInjection: 'none',
  }
}

function okExecutor(): HarnessExecutor {
  return {
    name: 'fake-harness',
    capabilities,
    start() {
      async function* events(): AsyncGenerator<TaskEvent> {
        yield { ts: Date.now(), type: 'turn.end', turn: 1, usage: ZERO }
      }
      return {
        events: events(),
        steer: () => Promise.resolve(),
        kill: () => Promise.resolve(),
        result: Promise.resolve(okResult),
      }
    },
  }
}

function hangExecutor(release: { current: () => void }): HarnessExecutor {
  return {
    name: 'fake-harness',
    capabilities,
    start() {
      async function* events(): AsyncGenerator<TaskEvent> {
        /* no turn — the result promise is what the runner waits on */
      }
      return {
        events: events(),
        steer: () => Promise.resolve(),
        kill: () => {
          release.current()
          return Promise.resolve()
        },
        result: new Promise((resolve) => {
          release.current = () => resolve(okResult)
        }),
      }
    },
  }
}

interface Running {
  store: SqliteTaskStore
  path: string
  base: string
  stopRunner: () => Promise<void>
  close: () => Promise<void>
}

async function start(executor: HarnessExecutor): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-delegate-'))
  const agentDir = join(dir, 'agent')
  const path = join(dir, 'tasks.db')
  const presets = new FileAgentPresetStore(join(dir, 'agents.json'))
  await presets.create({
    name: 'reviewer',
    node: NODE,
    harnessId: 'claude-code',
    model: MODEL,
    sharedLink: false,
    directory: agentDir,
  })

  let runner: PollingTaskRunner | undefined
  const store = new SqliteTaskStore(path, () => runner?.wake())
  const waiter = createTaskCompletionWaiter({ store })
  const executors: TaskExecutorRegistry = createExecutorRegistry()
  executors.register('harness-session', executor, 'claude-code')
  const resolver = createCachedPresetResolver(presets)
  runner = createPollingTaskRunner({
    store,
    nodeId: NODE,
    pollIntervalMs: 50,
    handler: createTaskHandler({
      store,
      executors,
      nodeId: NODE,
      workspaceDir: dir,
      resolvePreset: (id) => resolver.find(id),
      invalidatePreset: () => resolver.invalidate(),
    }),
  })
  await runner.start()

  const engine = new PresetDelegationEngine({
    resolver,
    taskStore: store,
    waiter,
    nodeName: NODE,
    executors,
    localQueue: true,
  })
  const routes: GatewayRoute[] = [
    createTaskApiRoute({
      store,
      waiter,
      resolvePreset: (agentId) => engine.find(agentId),
      resolveAffinity: async (agentId) => {
        const preset = await engine.find(agentId)
        if (preset?.node) return preset.node
        return { error: `agent "${agentId}" not found locally` }
      },
      presetHost: { nodeName: NODE, executors },
      localQueueNode: NODE,
    }),
    createCatalogApiRoute({
      nodeName: NODE,
      router: { getAgents: () => [], getProviders: () => [] } as unknown as Router,
      tools: () => [],
      executors,
      presets: engine,
    }),
  ]
  const server = createServer((req, res) => {
    void dispatch(routes, req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${address.port}`
  let closed = false

  return {
    store,
    path,
    base,
    stopRunner: () => runner?.stop() ?? Promise.resolve(),
    close: async () => {
      if (closed) return
      closed = true
      await runner?.stop()
      await waiter.stop()
      store.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function dispatch(
  routes: GatewayRoute[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = routes
      .filter(
        (candidate) =>
          url.pathname === candidate.prefix || url.pathname.startsWith(`${candidate.prefix}/`),
      )
      .sort((a, b) => b.prefix.length - a.prefix.length)[0]
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    await route.handler(req, res)
  } catch (err: unknown) {
    if (!res.headersSent) {
      res.writeHead(500)
      res.end(err instanceof Error ? err.message : String(err))
    }
  }
}

function tools(base: string, parentTaskId?: string): DenToolsHandle {
  return createDenTools({
    denUrl: base,
    enableWrite: false,
    enableDelegate: true,
    requestedBy: 'sidecar',
    log: () => undefined,
    gateway: new RivetGateway({ baseUrl: base }),
    ...(parentTaskId ? { parentTaskId } : {}),
  })
}

async function text(handle: DenToolsHandle, name: string, args: Record<string, unknown>): Promise<string> {
  const found = handle.tools.find((tool) => tool.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  const result = await found.execute(args)
  if (typeof result !== 'string') throw new Error(`${name} returned a non-text result`)
  return result
}

describe('sqlite task engine over den delegate_task', () => {
  const running: Running[] = []

  afterEach(async () => {
    for (const item of running) await item.close()
    running.length = 0
  })

  it('lists the file preset, returns the fake output, and keeps the row across reopen', async () => {
    const live = await start(okExecutor())
    running.push(live)
    const handle = tools(live.base)

    const listed = await text(handle, 'list_agents', {})
    expect(listed).toContain('reviewer')

    const delegated = await text(handle, 'delegate_task', { to_agent: 'reviewer', task: 'say ok' })
    expect(delegated).toContain('DELEGATED-OK')
    expect(delegated).toContain('[completed]')

    const rows = await live.store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.spec.model).toBe(MODEL)
    expect(rows[0]?.status).toBe('completed')
    const id = rows[0]?.id
    if (!id) throw new Error('missing task id')

    const unknown = await text(handle, 'delegate_task', { to_agent: 'no-such-agent', task: 'nope' })
    expect(unknown.startsWith('[failed]')).toBe(true)
    expect(unknown).toContain('no-such-agent')

    const parent = await live.store.create({
      goal: 'parent',
      executor: 'chat-loop',
      agentId: 'reviewer',
      origin: 'tool',
      chainDepth: 3,
    })
    const deep = await text(
      tools(live.base, parent.id),
      'delegate_task',
      { to_agent: 'reviewer', task: 'too deep' },
    )
    expect(deep.startsWith('[failed]')).toBe(true)
    expect(deep).toContain('delegation chain too deep')

    await live.stopRunner()
    live.store.close()
    const reopened = new SqliteTaskStore(live.path)
    try {
      const again = await reopened.get(id)
      expect(again?.status).toBe('completed')
      expect(again?.spec.model).toBe(MODEL)
      expect(await reopened.list()).toHaveLength(2)
    } finally {
      reopened.close()
    }
  })

  it('formats a hung delegation as [timeout] and releases the handler afterwards', async () => {
    const release = { current: () => undefined }
    const live = await start(hangExecutor(release))
    running.push(live)
    try {
      const delegated = await text(tools(live.base), 'delegate_task', {
        to_agent: 'reviewer',
        task: 'hang',
        timeout_ms: 500,
      })
      expect(delegated.startsWith('[timeout]')).toBe(true)
      expect(delegated).toContain('wait deadline exceeded')
      expect(delegated).toContain('killed')
    } finally {
      // requestKill does not abort the in-flight turn. Unblock it so stop() can drain.
      release.current()
    }
  })
})
