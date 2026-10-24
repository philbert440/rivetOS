import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type UseQueryOptions,
} from '@tanstack/react-query'
import { GatewayError } from '@rivetos/gateway-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// query-core decides at import time whether it runs on a server, and on a
// server it never polls. Give it a window before any import so refetch
// intervals and retries behave as they do in the app.
const captured = vi.hoisted(() => {
  vi.stubGlobal('window', {
    location: { origin: 'https://node.example' },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  })
  return { options: new Map<string, UseQueryOptions>() }
})

// Keep real query state and scheduling; capture the options each page passes
// so QueryObservers can run them without a browser DOM.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: (options: UseQueryOptions) => {
      captured.options.set(String(options.queryKey[0]), options)
      return actual.useQuery(options)
    },
  }
})

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: (props: { children?: unknown }) => createElement('a', null, props.children as never),
    useNavigate: () => () => Promise.resolve(),
    useParams: () => ({ runId: 'r1', workflowId: 'demo' }),
    useBlocker: () => undefined,
  }
})

vi.mock('../stores/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/connection.js')>()
  return {
    ...actual,
    useConnection: Object.assign((selector?: (s: unknown) => unknown) => {
      const state = actual.useConnection.getState()
      return selector ? selector(state) : state
    }, actual.useConnection),
  }
})

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

const BASE = 'https://node.example'
const UNAVAILABLE = 'Workflows are not available on this node.'
const notFound = (): GatewayError => new GatewayError(404, 'not found', { error: 'not found' })

let useConnection: (typeof import('../stores/connection.js'))['useConnection']
const pages: Record<string, ComponentType> = {}
let client: QueryClient
const observers = new Map<string, QueryObserver>()
const unsubscribers: Array<() => void> = []

beforeAll(async () => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
  ;({ useConnection } = await import('../stores/connection.js'))
  const mod = await import('./workflows-hub.js')
  pages.hub = mod.WorkflowsHubPage
  pages.run = mod.WorkflowRunDetailPage
  pages.trigger = mod.WorkflowTriggerPage
})

beforeEach(() => {
  vi.useFakeTimers()
  // Production defaults (main.tsx). retryOnMount is off only so the
  // static render shows the settled state instead of the optimistic
  // refetch-on-mount placeholder; the observers drive the real fetches.
  client = new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, retry: 1, retryOnMount: false } },
  })
  captured.options.clear()
  useConnection.setState({ baseUrl: BASE, roster: [{ name: 'node', baseUrl: BASE }] })
})

afterEach(() => {
  for (const off of unsubscribers.splice(0)) off()
  observers.clear()
  client.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

afterAll(() => vi.unstubAllGlobals())

function render(page: string): string {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(pages[page])),
  )
}

/** Render, then mount (or update) an observer per query the page declared —
 *  the same thing React does on each commit. */
function commit(page: string): string {
  const html = render(page)
  for (const [key, options] of captured.options) {
    const existing = observers.get(key)
    if (existing) {
      existing.setOptions(options)
      continue
    }
    const observer = new QueryObserver(client, options)
    observers.set(key, observer)
    unsubscribers.push(observer.subscribe(() => {}))
  }
  return html
}

async function runFor(page: string, ms: number): Promise<string> {
  let html = commit(page)
  for (let t = 0; t < ms; t += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000)
    html = commit(page)
  }
  return html
}

describe('workflows on a node without the workflows API', () => {
  it('hub probes once, never asks for runs, and shows the not-available state', async () => {
    const gateway = useConnection.getState().gateway
    const defs = vi.spyOn(gateway, 'listWorkflows').mockRejectedValue(notFound())
    const runs = vi.spyOn(gateway, 'listWorkflowRuns').mockRejectedValue(notFound())

    const html = await runFor('hub', 60_000)

    expect(defs).toHaveBeenCalledTimes(1)
    expect(runs).not.toHaveBeenCalled()
    expect(html).toContain(UNAVAILABLE)
    expect(html).not.toContain('not found')
  })

  it('run detail does not poll the run route and shows the not-available state', async () => {
    const gateway = useConnection.getState().gateway
    const defs = vi.spyOn(gateway, 'listWorkflows').mockRejectedValue(notFound())
    const run = vi.spyOn(gateway, 'getWorkflowRun').mockRejectedValue(notFound())

    const html = await runFor('run', 60_000)

    expect(defs).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    expect(html).toContain(UNAVAILABLE)
  })

  it('trigger page does not fetch the def and shows the not-available state', async () => {
    const gateway = useConnection.getState().gateway
    const defs = vi.spyOn(gateway, 'listWorkflows').mockRejectedValue(notFound())
    const def = vi.spyOn(gateway, 'getWorkflow').mockRejectedValue(notFound())

    const html = await runFor('trigger', 30_000)

    expect(defs).toHaveBeenCalledTimes(1)
    expect(def).not.toHaveBeenCalled()
    expect(html).toContain(UNAVAILABLE)
  })
})

describe('workflows on a node that serves them', () => {
  it('hub keeps polling defs and runs', async () => {
    const gateway = useConnection.getState().gateway
    const defs = vi.spyOn(gateway, 'listWorkflows').mockResolvedValue({ workflows: [] })
    const runs = vi.spyOn(gateway, 'listWorkflowRuns').mockResolvedValue({ runs: [] })

    const html = await runFor('hub', 12_000)

    expect(defs.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(runs.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(html).not.toContain(UNAVAILABLE)
    expect(html).toContain('no runs yet')
  })

  it('a transient defs failure is retried and reported, not treated as not-available', async () => {
    const gateway = useConnection.getState().gateway
    const defs = vi
      .spyOn(gateway, 'listWorkflows')
      .mockRejectedValue(new GatewayError(503, 'upstream down', null))

    const html = await runFor('hub', 2_000)

    expect(defs.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(html).not.toContain(UNAVAILABLE)
    expect(html).toContain('upstream down')
  })
})
